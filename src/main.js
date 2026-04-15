const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    shell,
    clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const SyncEngine = require("./services/sync-engine");
const ManifestManager = require("./utils/manifest-manager");
const ShippingCalculator = require("./services/shipping-calculator");
const ShopifyClient = require("./services/shopify-client");

// Auto-reload the app on source changes during local development.
if (!app.isPackaged) {
    try {
        require("electron-reloader")(module, {
            watchRenderer: true,
        });
    } catch (err) {
        console.warn("electron-reloader unavailable:", err.message);
    }
}

// Fix for Windows Cache/GPU errors which can cause blank rendering
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration(); // Nuclear option for blank screens

let mainWindow;

function scanDirectoryForProducts(basePath) {
    console.log(`[Scan] Scanning directory: ${basePath}`);
    if (!fs.existsSync(basePath)) {
        console.log(`[Scan] Path does not exist: ${basePath}`);
        return [];
    }

    const ignoredFolders = [
        ".git",
        "node_modules",
        "src",
        "utils",
        "services",
        "ui",
        ".vscode",
        "dist",
        "build",
        ".manifest_history",
    ];

    try {
        const entries = fs.readdirSync(basePath, { withFileTypes: true });
        console.log(`[Scan] Found ${entries.length} entries in root.`);

        // Filter out files and ignored folders
        const productFolders = entries.filter(
            (dirent) =>
                dirent.isDirectory() &&
                !ignoredFolders.includes(dirent.name) &&
                !dirent.name.startsWith("."),
        );
        console.log(
            `[Scan] Found ${productFolders.length} candidate product folders.`,
        );

        // Map folders to product objects, only if they contain media
        return productFolders
            .map((folder) => {
                const productPath = path.join(basePath, folder.name);
                let files = [];
                try {
                    files = fs
                        .readdirSync(productPath)
                        .filter((file) =>
                            /\.(jpg|jpeg|png|gif|mp4|mov|webp)$/i.test(file),
                        );
                } catch (err) {
                    console.log(
                        `[Scan] Error accessing ${folder.name}: ${err.message}`,
                    );
                    return null;
                }

                if (files.length === 0) {
                    console.log(
                        `[Scan] Folder ${folder.name} has no media files. Skipping.`,
                    );
                    return null;
                }

                return {
                    title: folder.name,
                    handle: folder.name,
                    media: files.map((f) => ({
                        src: path.join(productPath, f),
                        filename: f,
                        status: "local",
                        type:
                            f.endsWith(".mp4") || f.endsWith(".mov")
                                ? "video"
                                : "image",
                    })),
                };
            })
            .filter((p) => p !== null); // Remove nulls (empty/error folders)
    } catch (e) {
        console.error("Error scanning directory:", e);
        return [];
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // Keeping simple for this prototype
        },
    });

    mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
}

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

// --- IPC HANDLERS ---

ipcMain.handle("select-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
    });
    return result.filePaths[0];
});

ipcMain.handle("open-folder", async (event, folderPath) => {
    await shell.openPath(folderPath);
});
ipcMain.handle("load-library", async (event, folderPath) => {
    console.log(`[IPC] load-library called with: '${folderPath}'`);
    if (!folderPath) return [];

    // 1. Scan Physical Directory (Single Truth)
    const physicalProducts = scanDirectoryForProducts(folderPath);
    console.log(
        `[IPC] Physical Scan found ${physicalProducts.length} products`,
    );

    // 2. Load Manifest for Metadata Overlay (Optional)
    const manifest = new ManifestManager(folderPath);
    await manifest.load();
    const manifestProducts = manifest.getAllProducts();

    // 3. Enhance physical results with manifest data if available
    const enhancedResults = physicalProducts.map((p) => {
        const folderName = p.handle; // This is the folder name, may be "handle-sku"

        // Try to find matching product in manifest
        // First try exact match (handle-sku), then try to extract handle from folder name
        let manifestProduct = manifestProducts[folderName];
        let actualHandle = folderName;

        if (!manifestProduct) {
            // If no exact match, search for a product whose folderName matches
            for (const [mHandle, mData] of Object.entries(manifestProducts)) {
                if ((mData.folderName || mHandle) === folderName) {
                    manifestProduct = mData;
                    actualHandle = mHandle; // Use the manifest key as the actual handle
                    break;
                }
            }
        }

        // Update product with actual handle
        p.handle = actualHandle;
        p.title = p.title || actualHandle;

        if (manifestProduct) {
            // Merge metadata from manifest
            p.sku = manifestProduct.sku || "";
            p.category = manifestProduct.category || "";
            p.tags = manifestProduct.tags || [];
            p.shopifyId = manifestProduct.id || "";

            p.media = p.media.map((m) => {
                const knownFile = manifestProduct.media
                    ? manifestProduct.media.find(
                          (tm) => tm.filename === m.filename,
                      )
                    : null;
                // Use persisted 'lastStatus' if available, otherwise 'unchanged'
                const manifestStatus = knownFile
                    ? knownFile.lastStatus || "unchanged"
                    : "local";

                let group =
                    knownFile && knownFile.group ? knownFile.group : m.group;

                // Fallback inference if group is missing
                if (!group || group === "unknown") {
                    if (m.filename.startsWith("banner-")) group = "banner";
                    else if (m.filename.startsWith("extra-")) group = "extra";
                    else if (m.filename.startsWith("main-")) group = "main";
                    else group = "other";
                }

                return {
                    ...m,
                    status: manifestStatus,
                    group: group,
                    shopifyId: knownFile ? knownFile.id || "" : "",
                    position: knownFile ? knownFile.position || 0 : 0,
                };
            });
        } else {
            // Product folder exists but not in manifest -> All local
            p.media = p.media.map((m) => {
                let group = "other";
                if (m.filename.startsWith("banner-")) group = "banner";
                else if (m.filename.startsWith("extra-")) group = "extra";
                else if (m.filename.startsWith("main-")) group = "main";

                return { ...m, status: "local", group };
            });
        }
        return p;
    });

    return enhancedResults;
});
ipcMain.handle("start-sync", async (event, config) => {
    const { apiKey, shopUrl, downloadPath } = config;

    if (!apiKey || !shopUrl || !downloadPath) throw new Error("Missing Config");

    const engine = new SyncEngine(config);

    try {
        // Pass a progress callback that sends IPC messages to renderer
        const results = await engine.run((progressData) => {
            mainWindow.webContents.send("sync-progress", progressData);
        });
        return results;
    } catch (error) {
        console.error(error);
        throw error;
    }
});

ipcMain.handle("cleanup-unused-images", async (event, folderPath) => {
    console.log(`[Cleanup] Starting cleanup in: ${folderPath}`);
    if (!folderPath) return { scanned: 0, deleted: 0 };

    // Validate path exists
    if (!fs.existsSync(folderPath)) {
        throw new Error("Folder path does not exist");
    }

    const manifest = new ManifestManager(folderPath);
    await manifest.load();
    const manifestProducts = manifest.getAllProducts(); // object: handle -> productData

    // Build a reverse map: folderName -> productData.
    // The sync engine stores the folder as `handle-sku` but the manifest key is the bare
    // handle, so looking up by entry.name (folder name) would always miss for SKU products.
    const folderToManifest = new Map();
    for (const [handle, product] of Object.entries(manifestProducts)) {
        const key = product.folderName || handle; // folderName added by sync-engine
        folderToManifest.set(key, product);
    }

    let scannedCount = 0;
    let deletedCount = 0;

    const ignoredFolders = [
        ".git",
        "node_modules",
        "src",
        "utils",
        "services",
        "ui",
        ".vscode",
        "dist",
        "build",
        ".manifest_history",
    ];

    let entries;
    try {
        entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch (e) {
        throw new Error(`Failed to read directory: ${e.message}`);
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (ignoredFolders.includes(entry.name)) continue;

        const productHandle = entry.name;
        const productPath = path.join(folderPath, productHandle);

        const manifestProduct = folderToManifest.get(productHandle);
        // If undefined, validFilenames is empty -> delete all media in this folder
        const validFilenames =
            manifestProduct && manifestProduct.media
                ? new Set(manifestProduct.media.map((m) => m.filename))
                : new Set();

        let productFiles;
        try {
            productFiles = fs.readdirSync(productPath);
        } catch (e) {
            console.error(
                `[Cleanup] Skipping inaccessible folder: ${productHandle}`,
            );
            continue;
        }

        for (const file of productFiles) {
            // Only target media files
            if (/\.(jpg|jpeg|png|gif|mp4|mov|webp)$/i.test(file)) {
                scannedCount++;
                if (!validFilenames.has(file)) {
                    const filePath = path.join(productPath, file);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(
                            `[Cleanup] Deleted: ${file} (Product: ${productHandle})`,
                        );
                        deletedCount++;
                    } catch (err) {
                        console.error(
                            `[Cleanup] Failed to delete ${file}:`,
                            err,
                        );
                    }
                }
            }
        }
    }

    return { scanned: scannedCount, deleted: deletedCount };
});

ipcMain.handle(
    "calculate-shipping",
    async (event, { shopUrl, apiKey, handles, variantIds, address }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (
            !address ||
            !address.address1 ||
            !address.city ||
            !address.zip ||
            !address.countryCode
        ) {
            throw new Error(
                "Address is incomplete (address1, city, zip, countryCode required)",
            );
        }

        const calculator = new ShippingCalculator(shopUrl, apiKey);
        const progress = (progressEvent) => {
            mainWindow.webContents.send("shipping-progress", progressEvent);
        };

        const hasVariantIds = variantIds && variantIds.length > 0;
        const hasHandles = handles && handles.length > 0;

        if (!hasVariantIds && !hasHandles)
            throw new Error("Provide either product handles or variant IDs.");

        if (hasVariantIds) {
            return calculator.calculateFromVariantIds(
                variantIds,
                address,
                progress,
            );
        } else {
            return calculator.calculate(handles, address, progress);
        }
    },
);

ipcMain.handle(
    "reorder-product-media",
    async (event, { shopUrl, apiKey, reorders }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!Array.isArray(reorders) || reorders.length === 0)
            throw new Error("No reorders provided");

        const client = new ShopifyClient(shopUrl, apiKey);
        const results = [];

        for (const { handle, productId, moves } of reorders) {
            try {
                await client.reorderProductMedia(productId, moves);
                results.push({ handle, success: true });
            } catch (err) {
                console.error(`[Reorder] Failed for ${handle}:`, err.message);
                results.push({ handle, success: false, error: err.message });
            }
        }

        return results;
    },
);

ipcMain.handle(
    "fetch-product-id",
    async (event, { shopUrl, apiKey, handle }) => {
        if (!shopUrl || !apiKey) throw new Error("Missing credentials");
        if (!handle) throw new Error("Missing product handle");

        try {
            const client = new ShopifyClient(shopUrl, apiKey);
            const productId = await client.getProductIdByHandle(handle);
            if (!productId) {
                throw new Error(`Product not found: ${handle}`);
            }
            return productId;
        } catch (err) {
            console.error(
                `[FetchProductId] Failed for ${handle}:`,
                err.message,
            );
            throw err;
        }
    },
);

// ============ EXPORT HANDLERS ============

ipcMain.handle(
    "test-export-products",
    async (event, { shopUrl, apiKey, metafields }) => {
        if (!shopUrl || !apiKey) throw new Error("Missing credentials");

        try {
            console.log("[Export] Starting test export...");
            const client = new ShopifyClient(shopUrl, apiKey);
            const testData = await client.testExportData(metafields, 3);

            console.log(
                `[Export] Test complete: ${testData.productCount} products`,
            );
            return testData;
        } catch (err) {
            console.error("[Export] Test failed:", err.message);
            throw err;
        }
    },
);

ipcMain.handle(
    "export-all-products",
    async (event, { shopUrl, apiKey, metafields }) => {
        if (!shopUrl || !apiKey) throw new Error("Missing credentials");

        try {
            console.log("[Export] Starting full export...");
            const client = new ShopifyClient(shopUrl, apiKey);

            // Progress callback that sends updates to renderer
            const onProgress = (progress) => {
                mainWindow.webContents.send("export-progress", {
                    page: progress.page,
                    pageSize: progress.pageSize,
                    totalProducts: progress.totalProducts,
                    hasMore: progress.hasMore,
                });
            };

            const products = await client.getAllProductsForExport(
                metafields,
                onProgress,
            );

            // Generate CSV
            mainWindow.webContents.send("export-progress", {
                status: "generating",
                totalProducts: products.length,
            });
            const csv = generateProductsCSV(products);

            const choice = await dialog.showMessageBox(mainWindow, {
                type: "question",
                buttons: [
                    "Save CSV File",
                    "Copy for Excel/Google Sheets",
                    "Cancel",
                ],
                defaultId: 0,
                cancelId: 2,
                title: "Export Ready",
                message: "Export data is ready.",
                detail: "Choose where to send it: save as a CSV file, or copy tab-separated rows to clipboard for direct paste.",
            });

            if (choice.response === 2) {
                return {
                    success: false,
                    action: "cancelled",
                    productCount: products.length,
                };
            }

            if (choice.response === 1) {
                const tsv = csvToTsv(csv);
                clipboard.writeText(tsv);

                return {
                    success: true,
                    action: "copied",
                    productCount: products.length,
                };
            }

            // Save to file - use electron dialog to pick location
            const { filePath } = await dialog.showSaveDialog(mainWindow, {
                defaultPath: `products-export-${new Date().toISOString().split("T")[0]}.csv`,
                filters: [{ name: "CSV Files", extensions: ["csv"] }],
            });

            if (!filePath) {
                return {
                    success: false,
                    action: "cancelled",
                    productCount: products.length,
                };
            }

            fs.writeFileSync(filePath, csv, "utf-8");
            console.log(`[Export] Saved to: ${filePath}`);

            return {
                success: true,
                action: "saved",
                filepath: filePath,
                productCount: products.length,
            };
        } catch (err) {
            console.error("[Export] Failed:", err.message);
            throw err;
        }
    },
);

function csvToTsv(csvText) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                field += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (ch === "\r") {
            // Ignore CR in CRLF endings.
        } else {
            field += ch;
        }
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.map((r) => r.join("\t")).join("\n");
}

function generateProductsCSV(products) {
    // CSV Headers matching Shopify export format
    const headers = [
        "Handle",
        "Title",
        "Body (HTML)",
        "Vendor",
        "Product Category",
        "Type",
        "Tags",
        "Published",
        "Option1 Name",
        "Option1 Value",
        "Option1 Linked To",
        "Option2 Name",
        "Option2 Value",
        "Option2 Linked To",
        "Option3 Name",
        "Option3 Value",
        "Option3 Linked To",
        "Variant SKU",
        "Variant Grams",
        "Variant Inventory Tracker",
        "Variant Inventory Qty",
        "Variant Inventory Policy",
        "Variant Fulfillment Service",
        "Variant Price",
        "Variant Compare At Price",
        "Variant Requires Shipping",
        "Variant Taxable",
        "Unit Price Total Measure",
        "Unit Price Total Measure Unit",
        "Unit Price Base Measure",
        "Unit Price Base Measure Unit",
        "Variant Barcode",
        "Image Src",
        "Image Position",
        "Image Alt Text",
        "Gift Card",
        "SEO Title",
        "SEO Description",
        "Google Shopping / Google Product Category",
        "Google Shopping / Gender",
        "Google Shopping / Age Group",
        "Google Shopping / MPN",
        "Google Shopping / Condition",
        "Google Shopping / Custom Product",
        "Google Shopping / Custom Label 0",
        "Google Shopping / Custom Label 1",
        "Google Shopping / Custom Label 2",
        "Google Shopping / Custom Label 3",
        "Google Shopping / Custom Label 4",
        "Also Like (product.metafields.custom.also_like)",
        "Benefits (product.metafields.custom.benefits)",
        "Cautions (product.metafields.custom.cautions)",
        "Collection Name (product.metafields.custom.collection_name)",
        "Custom Questions (product.metafields.custom.custom_questions)",
        "Disclaimer (product.metafields.custom.disclaimer)",
        "How to use (product.metafields.custom.how_to_use)",
        "Ingredients (product.metafields.custom.ingredients)",
        "Keywords (product.metafields.custom.keywords)",
        "Key Features (product.metafields.custom.key_features)",
        "Key Ingredients & Benefits (product.metafields.custom.key_ingredients_benefits)",
        "Key Message (product.metafields.custom.key_message)",
        "Materials (product.metafields.custom.materials)",
        "Overview (product.metafields.custom.overview)",
        "question_answers (product.metafields.custom.question_answers)",
        "Short Title (product.metafields.custom.short_title)",
        "Suitable For Skin Type (product.metafields.custom.suitable_for_skin_type)",
        "User Review (product.metafields.custom.user_review)",
        "Use It With (product.metafields.custom.use_it_with)",
        "Youtube Video Links (product.metafields.custom.youtube_video_links)",
        "Google: Custom Product (product.metafields.mm-google-shopping.custom_product)",
        "Fragrance (product.metafields.shopify.fragrance)",
        "Moisturizer type (product.metafields.shopify.moisturizer-type)",
        "Product form (product.metafields.shopify.product-form)",
        "Variant Image",
        "Variant Weight Unit",
        "Variant Tax Code",
        "Cost per item",
        "Status",
    ];

    // Helper to escape CSV values
    const escapeCSV = (val) => {
        if (val === null || val === undefined) return "";
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    // Helper to get metafield value
    const getMetafieldValue = (product, path) => {
        const fields = path.split(".");
        let current = product;
        for (const field of fields) {
            if (!current) return "";
            // Handle different metafield formats from GraphQL
            if (field.startsWith("mf_")) {
                const mfData = current[field];
                if (mfData && mfData.value) {
                    return mfData.value;
                }
                return "";
            }
            current = current[field];
        }
        return current || "";
    };

    const rows = [];

    // Process each product
    products.forEach((productEdge) => {
        const product = productEdge.node;
        const variants = product.variants?.edges || [];
        const images = product.images?.edges || [];
        const options = product.options || [];

        // Ensure we have at least one variant row
        const variantsToExport =
            variants.length > 0
                ? variants
                : [{ node: { title: null, sku: null } }];

        variantsToExport.forEach((variantEdge, variantIdx) => {
            const variant = variantEdge?.node || variantEdge;
            const inventoryItem = variant.inventoryItem || {};

            // Get image for this variant or use image from product images that matches variant image
            const imageForVariant =
                variant.image &&
                images.find((im) => im.node.url === variant.image.url);
            const imageToUse =
                imageForVariant ||
                (variantIdx < images.length ? images[variantIdx] : null);

            const row = [
                product.handle, // Handle
                product.title, // Title
                escapeCSV(product.bodyHtml), // Body (HTML)
                product.vendor, // Vendor
                product.category?.name || "", // Product Category
                product.productType || "", // Type
                Array.isArray(product.tags) ? product.tags.join(",") : "", // Tags
                product.publishedAt ? "true" : "false", // Published
                options[0]?.name || "", // Option1 Name
                options[0]?.values?.[variantIdx] || "", // Option1 Value
                "", // Option1 Linked To
                options[1]?.name || "", // Option2 Name
                options[1]?.values?.[variantIdx] || "", // Option2 Value
                "", // Option2 Linked To
                options[2]?.name || "", // Option3 Name
                options[2]?.values?.[variantIdx] || "", // Option3 Value
                "", // Option3 Linked To
                variant.sku || "", // Variant SKU
                "", // Variant Grams (not available from GraphQL)
                inventoryItem.tracked ? "shopify" : "", // Variant Inventory Tracker
                variant.inventoryQuantity || 0, // Variant Inventory Qty
                inventoryItem.tracked ? "deny" : "", // Variant Inventory Policy
                "", // Variant Fulfillment Service (not available in GraphQL)
                variant.price || "", // Variant Price
                variant.compareAtPrice || "", // Variant Compare At Price
                inventoryItem.requiresShipping ? "true" : "false", // Variant Requires Shipping
                variant.taxable ? "true" : "false", // Variant Taxable
                "", // Unit Price Total Measure
                "", // Unit Price Total Measure Unit
                "", // Unit Price Base Measure
                "", // Unit Price Base Measure Unit
                variant.barcode || "", // Variant Barcode
                imageToUse?.node?.url || "", // Image Src
                imageToUse ? variantIdx + 1 : "", // Image Position (use variant index)
                imageToUse?.node?.altText || "", // Image Alt Text
                "", // Gift Card
                getMetafieldValue(product, "seoTitle.value") || "", // SEO Title
                getMetafieldValue(product, "seoDescription.value") || "", // SEO Description
                "", // Google Shopping / Google Product Category
                "", // Google Shopping / Gender
                "", // Google Shopping / Age Group
                "", // Google Shopping / MPN
                "", // Google Shopping / Condition
                "", // Google Shopping / Custom Product
                "", // Google Shopping / Custom Label 0
                "", // Google Shopping / Custom Label 1
                "", // Google Shopping / Custom Label 2
                "", // Google Shopping / Custom Label 3
                "", // Google Shopping / Custom Label 4
                getMetafieldValue(product, "mf_0.value") || "", // Also Like
                getMetafieldValue(product, "mf_1.value") || "", // Benefits
                getMetafieldValue(product, "mf_2.value") || "", // Cautions
                getMetafieldValue(product, "mf_3.value") || "", // Collection Name
                getMetafieldValue(product, "mf_4.value") || "", // Custom Questions
                getMetafieldValue(product, "mf_5.value") || "", // Disclaimer
                getMetafieldValue(product, "mf_6.value") || "", // How to use
                getMetafieldValue(product, "mf_7.value") || "", // Ingredients
                getMetafieldValue(product, "mf_8.value") || "", // Keywords
                getMetafieldValue(product, "mf_9.value") || "", // Key Features
                getMetafieldValue(product, "mf_10.value") || "", // Key Ingredients & Benefits
                getMetafieldValue(product, "mf_11.value") || "", // Key Message
                getMetafieldValue(product, "mf_12.value") || "", // Materials
                getMetafieldValue(product, "mf_13.value") || "", // Overview
                getMetafieldValue(product, "mf_14.value") || "", // Question Answers
                getMetafieldValue(product, "mf_15.value") || "", // Short Title
                getMetafieldValue(product, "mf_16.value") || "", // Suitable For Skin Type
                getMetafieldValue(product, "mf_17.value") || "", // User Review
                getMetafieldValue(product, "mf_18.value") || "", // Use It With
                getMetafieldValue(product, "mf_19.value") || "", // Youtube Video Links
                getMetafieldValue(product, "metafieldGoogleProduct.value") ||
                    "", // Google: Custom Product
                getMetafieldValue(product, "metafieldFragrance.value") || "", // Fragrance
                getMetafieldValue(product, "metafieldMoisturizerType.value") ||
                    "", // Moisturizer type
                getMetafieldValue(product, "metafieldProductForm.value") || "", // Product form
                variant.image?.url || "", // Variant Image
                "", // Variant Weight Unit (not available from GraphQL)
                variant.taxCode || "", // Variant Tax Code
                "", // Cost per item - Not available from GraphQL
                product.status, // Status
            ];

            rows.push(row.map(escapeCSV).join(","));
        });
    });

    // Combine headers and rows
    return [headers.map(escapeCSV).join(","), ...rows].join("\n");
}
