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

function restoreMainWindowFocus() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.focus();
        if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.focus();
        }
    }, 20);
}

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
                    folderPath: productPath,
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

function getMediaGroupFromFilename(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.startsWith("main-")) return "main";
    if (lower.startsWith("banner-")) return "banner";
    if (lower.startsWith("extra-")) return "extra";
    if (lower.startsWith("plus-")) return "plus";
    return "other";
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
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ["openDirectory"],
        });
        return result.filePaths[0];
    } finally {
        restoreMainWindowFocus();
    }
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

        // Update product with actual handle and title from manifest if available
        p.handle = actualHandle;
        p.title = manifestProduct?.title || p.title || actualHandle;
        p.folderName = manifestProduct?.folderName || folderName;
        p.productName = p.title;

        if (manifestProduct) {
            // Merge metadata from manifest
            p.sku = manifestProduct.sku || "";
            p.category = manifestProduct.category || "";
            p.tags = manifestProduct.tags || [];
            p.shopifyId = manifestProduct.id || "";
            p.folderPath = p.folderPath || path.join(folderPath, folderName);

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
                    else if (m.filename.startsWith("plus-")) group = "plus";
                    else if (m.filename.startsWith("main-")) group = "main";
                    else group = "other";
                }

                return {
                    ...m,
                    status: manifestStatus,
                    group: group,
                    shopifyId: knownFile ? knownFile.id || "" : "",
                    shopifyFileId: knownFile ? knownFile._fileId || "" : "",
                    position: knownFile ? knownFile.position || 0 : 0,
                };
            });
        } else {
            // Product folder exists but not in manifest -> All local
            p.media = p.media.map((m) => {
                let group = "other";
                if (m.filename.startsWith("banner-")) group = "banner";
                else if (m.filename.startsWith("extra-")) group = "extra";
                else if (m.filename.startsWith("plus-")) group = "plus";
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
    "export-library-images",
    async (event, { sourceRoot, selectedTypes }) => {
        if (!sourceRoot) throw new Error("Source folder is required");
        if (!fs.existsSync(sourceRoot)) {
            throw new Error("Source folder does not exist");
        }

        const { canceled, filePaths } = await dialog.showOpenDialog(
            mainWindow,
            {
                title: "Choose Export Destination Folder",
                properties: ["openDirectory", "createDirectory"],
            },
        );

        if (canceled || !filePaths || !filePaths[0]) {
            return { success: false, cancelled: true };
        }

        const destinationRoot = filePaths[0];
        const imageRegex = /\.(jpg|jpeg|png|gif|webp|bmp|avif|tif|tiff)$/i;
        const ignoredFolders = new Set([
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
        ]);

        const selected = new Set(
            Array.isArray(selectedTypes) ? selectedTypes : [],
        );
        const includeAll = selected.has("all");
        const includeGroups = includeAll
            ? new Set(["main", "banner", "extra", "plus", "other"])
            : selected;

        let copiedFiles = 0;
        let matchedFiles = 0;
        let visitedFolders = 0;

        const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".")) continue;
            if (ignoredFolders.has(entry.name)) continue;

            const srcProductFolder = path.join(sourceRoot, entry.name);
            const destProductFolder = path.join(destinationRoot, entry.name);
            visitedFolders++;

            let files = [];
            try {
                files = fs.readdirSync(srcProductFolder, {
                    withFileTypes: true,
                });
            } catch (err) {
                console.warn(
                    `[ExportImages] Skipping unreadable folder ${srcProductFolder}: ${err.message}`,
                );
                continue;
            }

            for (const fileEntry of files) {
                if (!fileEntry.isFile()) continue;
                if (!imageRegex.test(fileEntry.name)) continue;

                const group = getMediaGroupFromFilename(fileEntry.name);
                if (!includeGroups.has(group)) continue;

                matchedFiles++;
                const srcFile = path.join(srcProductFolder, fileEntry.name);
                const destFile = path.join(destProductFolder, fileEntry.name);

                try {
                    fs.mkdirSync(path.dirname(destFile), { recursive: true });
                    fs.copyFileSync(srcFile, destFile);
                    copiedFiles++;
                } catch (err) {
                    console.warn(
                        `[ExportImages] Failed to copy ${srcFile}: ${err.message}`,
                    );
                }
            }
        }

        restoreMainWindowFocus();
        return {
            success: true,
            cancelled: false,
            destinationRoot,
            visitedFolders,
            matchedFiles,
            copiedFiles,
            selectedTypes: Array.from(includeGroups),
        };
    },
);

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
    async (event, { shopUrl, apiKey, metafields, reorders }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!Array.isArray(reorders) || reorders.length === 0)
            throw new Error("No reorders provided");

        const client = new ShopifyClient(shopUrl, apiKey);
        const results = [];

        for (const { handle, layout } of reorders) {
            try {
                const outcome = await client.applyProductMediaLayout(
                    handle,
                    layout,
                    metafields,
                );
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

ipcMain.handle(
    "remove-product-images",
    async (event, { shopUrl, apiKey, metafields, removals }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!Array.isArray(removals) || removals.length === 0)
            throw new Error("No image removals provided");

        const client = new ShopifyClient(shopUrl, apiKey);
        const results = [];

        for (const removal of removals) {
            const { handle, images = [], folderPath } = removal;

            try {
                const outcome = await client.removeSelectedProductImages(
                    handle,
                    images,
                    metafields,
                );

                for (const image of images) {
                    const candidatePath =
                        image.src ||
                        (folderPath && image.filename
                            ? path.join(folderPath, image.filename)
                            : null);

                    if (candidatePath && fs.existsSync(candidatePath)) {
                        try {
                            fs.unlinkSync(candidatePath);
                        } catch (err) {
                            console.warn(
                                `[RemoveMedia] Shopify delete succeeded but local delete failed for ${candidatePath}: ${err.message}`,
                            );
                        }
                    }
                }

                results.push({
                    handle,
                    success: true,
                    removedCount: images.length,
                    detachedFileIds: outcome.detachedFileIds,
                });
            } catch (err) {
                console.error(
                    `[RemoveMedia] Failed for ${handle}:`,
                    err.message,
                );
                results.push({
                    handle,
                    success: false,
                    error: err.message,
                });
            }
        }

        return results;
    },
);

// ============ PUSH PLUS HANDLER ============

ipcMain.handle(
    "set-plus-metafield",
    async (
        event,
        {
            shopUrl,
            apiKey,
            metafields: metafieldKeysString,
            handle,
            mediaIds,
            append = true,
        },
    ) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!handle) throw new Error("Missing product handle");
        if (!Array.isArray(mediaIds) || mediaIds.length === 0)
            throw new Error("No media IDs provided");

        // Locate the more_description metafield key from the configured keys string
        const parseKeys = (str = "") =>
            str
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => {
                    const dot = s.indexOf(".");
                    return dot > -1
                        ? { namespace: s.slice(0, dot), key: s.slice(dot + 1) }
                        : { namespace: "custom", key: s };
                });

        const keys = parseKeys(metafieldKeysString);
        const plusKey = keys.find(
            ({ key }) =>
                key.toLowerCase().endsWith("more_description") ||
                key.toLowerCase().endsWith("moredescription"),
        );
        if (!plusKey) {
            throw new Error(
                "No more_description metafield key found in configured metafield keys. " +
                    "Add a key ending in 'more_description' in the dashboard first.",
            );
        }

        const client = new ShopifyClient(shopUrl, apiKey);

        // Fetch live media to get CDN URLs for the given Shopify GIDs
        const product = await client.getProductMediaContext(
            handle,
            metafieldKeysString,
        );
        if (!product) throw new Error(`Product not found: ${handle}`);

        // Build GID → CDN URL map from main media
        const gidToUrl = new Map();
        (product.media?.edges || []).forEach((edge) => {
            const node = edge?.node;
            if (!node || node.mediaContentType !== "IMAGE") return;
            const url = node.image?.originalSrc;
            if (url) gidToUrl.set(node.id, url);
        });

        // Also index metafield references (banner / extra)
        const parsedKeys = parseKeys(metafieldKeysString);
        parsedKeys.forEach(({ namespace, key }, index) => {
            const mf = product[`mf_${index}`];
            if (!mf) return;
            if (mf.reference?.image?.originalSrc) {
                gidToUrl.set(mf.reference.id, mf.reference.image.originalSrc);
            }
            (mf.references?.edges || []).forEach((e) => {
                const n = e?.node;
                if (n?.image?.originalSrc)
                    gidToUrl.set(n.id, n.image.originalSrc);
            });
        });

        // Resolve CDN URLs in the requested order
        const newUrls = mediaIds
            .map((gid) => gidToUrl.get(gid))
            .filter(Boolean);
        if (newUrls.length === 0) {
            throw new Error(
                "Could not resolve any CDN URLs for the selected images. " +
                    "Make sure the images are still attached to the product in Shopify.",
            );
        }

        // Read existing plus value and append (deduplicated by URL)
        let existingItems = [];
        const plusMfIndex = parsedKeys.findIndex(
            ({ key }) =>
                key.toLowerCase().endsWith("more_description") ||
                key.toLowerCase().endsWith("moredescription"),
        );
        if (append && plusMfIndex >= 0) {
            const existingMf = product[`mf_${plusMfIndex}`];
            if (existingMf?.value) {
                try {
                    const parsed = JSON.parse(existingMf.value);
                    if (Array.isArray(parsed)) {
                        existingItems = parsed.filter(
                            (item) =>
                                item && (item.url || typeof item === "string"),
                        );
                    }
                } catch {
                    // existing value not valid JSON — start fresh
                }
            }
        }

        // Build merged list: existing first, then new (skip duplicates by URL)
        const existingUrls = new Set(
            existingItems.map((item) =>
                typeof item === "string" ? item : item.url,
            ),
        );
        const addedUrls = newUrls.filter((url) => !existingUrls.has(url));
        const mergedItems = [
            ...existingItems,
            ...addedUrls.map((url) => ({ url, alt: "" })),
        ];

        // Build JSON value: array of { url, alt } objects
        const value = JSON.stringify(mergedItems);
        const appended = existingItems.length > 0 && addedUrls.length > 0;

        await client._setMetafields([
            {
                ownerId: product.id,
                namespace: plusKey.namespace,
                key: plusKey.key,
                type: "multi_line_text_field",
                value,
            },
        ]);

        return {
            success: true,
            handle,
            count: addedUrls.length,
            total: mergedItems.length,
            appended,
        };
    },
);

// ============ EXPORT HANDLERS ============

ipcMain.handle("export-numpad-selections", async (event, { csv, rowCount }) => {
    if (!csv) throw new Error("No CSV data provided");

    const choice = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: ["Save CSV File", "Copy for Excel/Google Sheets", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        title: "Export Numpad Selections",
        message: `${rowCount} product row(s) ready.`,
        detail: "Save as a CSV file, or copy tab-separated data to clipboard.",
    });

    restoreMainWindowFocus();

    if (choice.response === 2) return { success: false, reason: "cancelled" };

    if (choice.response === 1) {
        clipboard.writeText(csvToTsv(csv));
        return { success: true, action: "copied", rowCount };
    }

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `numpad-selections-${new Date().toISOString().split("T")[0]}.csv`,
        filters: [{ name: "CSV Files", extensions: ["csv"] }],
    });

    restoreMainWindowFocus();
    if (!filePath) return { success: false, reason: "cancelled" };

    fs.writeFileSync(filePath, csv, "utf-8");
    return { success: true, action: "saved", filepath: filePath, rowCount };
});

ipcMain.handle("export-plus-content", async (event, { folderPath }) => {
    if (!folderPath) throw new Error("No folder path provided");

    const manifest = new ManifestManager(folderPath);
    await manifest.load();
    const products = manifest.getAllProducts();

    // Build one row per plus image per product
    const rows = [];
    for (const [handle, prod] of Object.entries(products)) {
        const plusItems = (prod.media || []).filter((m) => m.group === "plus");
        for (const item of plusItems) {
            // URL is embedded in the synthetic id after the https:// marker
            const urlStart = String(item.id || "").indexOf("https://");
            const imageUrl = urlStart >= 0 ? item.id.slice(urlStart) : "";
            if (!imageUrl) continue;
            rows.push({
                handle,
                title: prod.title || handle,
                sku: prod.sku || "",
                imageUrl,
            });
        }
    }

    if (rows.length === 0) {
        return { success: false, reason: "no-plus-content" };
    }

    // Build CSV text
    const escCsv = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ["Handle", "Title", "SKU", "Image URL"].join(",");
    const body = rows
        .map((r) =>
            [
                escCsv(r.handle),
                escCsv(r.title),
                escCsv(r.sku),
                escCsv(r.imageUrl),
            ].join(","),
        )
        .join("\n");
    const csv = header + "\n" + body;

    const choice = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: ["Save CSV File", "Copy for Excel/Google Sheets", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        title: "Export Plus Content",
        message: `${rows.length} plus image row(s) ready.`,
        detail: "Save as a CSV file, or copy tab-separated data to clipboard for direct paste.",
    });

    restoreMainWindowFocus();

    if (choice.response === 2) {
        return { success: false, reason: "cancelled" };
    }

    if (choice.response === 1) {
        // Convert to TSV for clipboard
        const tsv = csvToTsv(csv);
        clipboard.writeText(tsv);
        return { success: true, action: "copied", rowCount: rows.length };
    }

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `plus-content-${new Date().toISOString().split("T")[0]}.csv`,
        filters: [{ name: "CSV Files", extensions: ["csv"] }],
    });

    restoreMainWindowFocus();

    if (!filePath) {
        return { success: false, reason: "cancelled" };
    }

    fs.writeFileSync(filePath, csv, "utf-8");
    return {
        success: true,
        action: "saved",
        filepath: filePath,
        rowCount: rows.length,
    };
});

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
        } finally {
            restoreMainWindowFocus();
        }
    },
);

// ============ BULK RENAME PLUS IMAGES ============

ipcMain.handle(
    "prepare-plus-rename",
    async (event, { shopUrl, apiKey, metafieldKeys, folderPath }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!folderPath) throw new Error("Missing folder path");

        const manifest = new ManifestManager(folderPath);
        await manifest.load();

        const client = new ShopifyClient(shopUrl, apiKey);
        const allProducts = manifest.getAllProducts();

        const parseKeys = (str = "") =>
            str
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => {
                    const dot = s.indexOf(".");
                    return dot > -1
                        ? {
                              namespace: s.slice(0, dot),
                              key: s.slice(dot + 1),
                          }
                        : { namespace: "custom", key: s };
                });

        const isMoreDescriptionKey = (key = "") => {
            const n = key.toLowerCase();
            return (
                n.endsWith("more_description") || n.endsWith("moredescription")
            );
        };

        const keys = parseKeys(metafieldKeys || "");
        const mfIndex = keys.findIndex(({ key }) => isMoreDescriptionKey(key));
        if (mfIndex < 0) {
            return {
                items: [],
                unresolvedCount: 0,
                error: "No more_description metafield key configured. Add a key ending in 'more_description' in the dashboard.",
            };
        }

        const plusHandles = Object.entries(allProducts)
            .filter(([, prod]) =>
                (prod.media || []).some((m) => m.group === "plus"),
            )
            .map(([handle, prod]) => ({
                handle,
                title: prod.title || handle,
            }));

        if (plusHandles.length === 0) {
            return { items: [], unresolvedCount: 0 };
        }

        const allItems = [];
        const productMeta = {}; // handle -> { productId, namespace, key, rawValue }
        let unresolvedCount = 0;

        // Process products concurrently: context fetch + GID resolution per product
        const CONCURRENCY = 10;
        for (let i = 0; i < plusHandles.length; i += CONCURRENCY) {
            const chunk = plusHandles.slice(i, i + CONCURRENCY);
            const chunkResults = await Promise.all(
                chunk.map(async ({ handle, title }) => {
                    try {
                        const product = await client.getProductMediaContext(
                            handle,
                            metafieldKeys,
                        );
                        if (!product) return null;

                        const mf = product[`mf_${mfIndex}`];
                        if (!mf?.value) return null;

                        let jsonItems = [];
                        try {
                            const parsed = JSON.parse(mf.value);
                            if (Array.isArray(parsed)) jsonItems = parsed;
                        } catch {
                            return null;
                        }

                        const fileEntries = jsonItems
                            .map((item, idx) => {
                                const rawUrl =
                                    typeof item === "string"
                                        ? item
                                        : item?.url || item?.src || "";
                                const cleanUrl = rawUrl.split("?")[0];
                                const filename = path.basename(
                                    decodeURIComponent(cleanUrl),
                                );
                                return {
                                    filename,
                                    url: cleanUrl,
                                    order: idx + 1,
                                };
                            })
                            .filter((e) => e.url && e.filename);

                        if (fileEntries.length === 0) return null;

                        const gidMap =
                            await client.resolveFileGidsByFilenames(
                                fileEntries,
                            );

                        return { handle, title, product, fileEntries, gidMap };
                    } catch (err) {
                        console.error(
                            `[PlusRename] Prep failed for ${handle}:`,
                            err.message,
                        );
                        return null;
                    }
                }),
            );

            for (const res of chunkResults) {
                if (!res) continue;
                const { handle, title, product, fileEntries, gidMap } = res;
                const productTitle = product.title || title;
                const mf = product[`mf_${mfIndex}`];

                productMeta[handle] = {
                    productId: product.id,
                    namespace: keys[mfIndex].namespace,
                    key: keys[mfIndex].key,
                    rawValue: mf.value,
                    type: mf.type || "json",
                };

                for (const { filename, url, order } of fileEntries) {
                    const ext = path.extname(filename) || ".jpg";
                    const newFilename = `${handle}-plus-${String(order).padStart(2, "0")}${ext}`;
                    const newAlt = `Extra Featured Image ${order} of ${productTitle}`;
                    const resolved = gidMap.get(url);

                    if (
                        resolved &&
                        resolved.currentFilename === newFilename &&
                        resolved.currentAlt === newAlt
                    ) {
                        continue;
                    }

                    allItems.push({
                        handle,
                        title: productTitle,
                        order,
                        gid: resolved?.id || null,
                        url,
                        currentFilename: filename,
                        newFilename,
                        newAlt,
                        resolved: !!resolved,
                    });

                    if (!resolved) unresolvedCount++;
                }
            }
        }

        allItems.sort(
            (a, b) => a.handle.localeCompare(b.handle) || a.order - b.order,
        );

        return { items: allItems, unresolvedCount, productMeta };
    },
);

ipcMain.handle(
    "execute-plus-rename",
    async (event, { shopUrl, apiKey, updates, productMeta }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!Array.isArray(updates) || updates.length === 0)
            throw new Error("No rename updates provided");

        const client = new ShopifyClient(shopUrl, apiKey);

        const fileUpdates = updates.map((u) => ({
            id: u.gid,
            filename: u.newFilename,
            alt: u.newAlt,
        }));

        // Detect forward naming conflicts: a rename whose target filename is currently
        // held by another file that is also being renamed in this batch (e.g. a swap or
        // reorder). Shopify processes the batch atomically so ordering cannot be controlled
        // — use a two-pass temp-rename to break the cycle.
        const currentFilenameSet = new Set(
            updates.map((u) => u.currentFilename),
        );
        const hasConflict = updates.some(
            (u) =>
                u.newFilename !== u.currentFilename &&
                currentFilenameSet.has(u.newFilename),
        );

        let result;
        if (hasConflict) {
            console.log(
                "[PlusRename] Naming conflicts detected — using two-pass temp rename.",
            );
            // Pass 1: rename all files to guaranteed-unique temp names
            const tmpUpdates = updates.map((u) => {
                const { name, ext } = path.parse(u.newFilename);
                return {
                    id: u.gid,
                    filename: `${name}--rnm${ext}`,
                    alt: u.newAlt,
                };
            });
            const pass1 = await client.bulkRenameFiles(tmpUpdates);

            // Pass 2: rename to final names (for pass1 successes: temp→final;
            // for pass1 failures: original→final retry, now unblocked)
            const pass2 = await client.bulkRenameFiles(fileUpdates);

            // Final status is determined by pass2 (did the file reach its target name?)
            result = { succeeded: pass2.succeeded, failed: pass2.failed };

            // Any file that failed both passes: keep its pass1 failure record for richer error info
            const pass2FailedIds = new Set(pass2.failed.map((f) => f.id));
            for (const f of pass1.failed) {
                if (f.id && pass2FailedIds.has(f.id)) {
                    const existing = result.failed.find((e) => e.id === f.id);
                    if (existing && !existing.pass1Error)
                        existing.pass1Error = f.error;
                }
            }
        } else {
            result = await client.bulkRenameFiles(fileUpdates);
        }

        console.log(
            `[PlusRename] Done. Succeeded: ${result.succeeded.length}, Failed: ${result.failed.length}`,
        );

        // Patch more_description metafields with new CDN URLs so next sync resolves correctly
        const alreadyNamedIds = new Set(
            (result.failed || [])
                .filter((f) => f.code === "FILENAME_ALREADY_EXISTS" && f.id)
                .map((f) => f.id),
        );
        const hasAnyResolved =
            result.succeeded.length > 0 || alreadyNamedIds.size > 0;
        if (hasAnyResolved && productMeta) {
            // Build gid -> newUrl map by reconstructing the new CDN URL from the old URL.
            // We cannot rely on the mutation response URL — fileUpdate is async on Shopify's
            // side so the returned URL is often still the old stale value.
            const succeededIds = new Set(result.succeeded.map((s) => s.id));
            // FILENAME_ALREADY_EXISTS means the file is already correctly named — treat as
            // resolved for metafield patching purposes (idempotent rename).
            const resolvedIds = new Set([...succeededIds, ...alreadyNamedIds]);
            // Map old URL -> { newUrl, newAlt } using URL reconstruction (mutation response
            // URL is stale because fileUpdate is async on Shopify's side).
            const oldUrlToNewData = new Map();
            for (const u of updates) {
                if (!resolvedIds.has(u.gid) || !u.url) continue;
                const dir = u.url.substring(0, u.url.lastIndexOf("/") + 1);
                oldUrlToNewData.set(u.url, {
                    newUrl: dir + u.newFilename,
                    newAlt: u.newAlt,
                });
            }

            const metafieldUpdates = [];
            for (const [handle, meta] of Object.entries(productMeta)) {
                // Only patch products that had at least one resolved rename
                const hasUpdate = updates.some(
                    (u) => u.handle === handle && resolvedIds.has(u.gid),
                );
                if (!hasUpdate) continue;

                try {
                    let jsonArr = JSON.parse(meta.rawValue);
                    if (!Array.isArray(jsonArr)) continue;

                    jsonArr = jsonArr.map((item) => {
                        const oldUrl =
                            typeof item === "string"
                                ? item
                                : item?.url || item?.src || "";
                        const cleanOld = oldUrl.split("?")[0];
                        const newData = oldUrlToNewData.get(cleanOld);
                        if (!newData) return item;
                        if (typeof item === "string") return newData.newUrl;
                        return {
                            ...item,
                            url: newData.newUrl,
                            alt: newData.newAlt,
                        };
                    });

                    metafieldUpdates.push({
                        ownerId: meta.productId,
                        namespace: meta.namespace,
                        key: meta.key,
                        type: meta.type || "json",
                        value: JSON.stringify(jsonArr),
                    });
                } catch (err) {
                    console.error(
                        `[PlusRename] Metafield patch failed for ${handle}:`,
                        err.message,
                    );
                }
            }

            if (metafieldUpdates.length > 0) {
                try {
                    await client._setMetafields(metafieldUpdates);
                    console.log(
                        `[PlusRename] Patched more_description for ${metafieldUpdates.length} product(s).`,
                    );
                    result.metafieldsPatchedCount = metafieldUpdates.length;
                } catch (err) {
                    console.error(
                        `[PlusRename] Metafields patch error:`,
                        err.message,
                    );
                    result.metafieldsPatchError = err.message;
                }
            }
        }

        return result;
    },
);

ipcMain.handle(
    "patch-plus-metafields",
    async (event, { shopUrl, apiKey, metafieldKeys, folderPath }) => {
        if (!shopUrl || !apiKey)
            throw new Error("Missing Shop URL or API Token");
        if (!folderPath) throw new Error("Missing folder path");

        const manifest = new ManifestManager(folderPath);
        await manifest.load();
        const client = new ShopifyClient(shopUrl, apiKey);
        const allProducts = manifest.getAllProducts();

        const parseKeys = (str = "") =>
            str
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => {
                    const dot = s.indexOf(".");
                    return dot > -1
                        ? { namespace: s.slice(0, dot), key: s.slice(dot + 1) }
                        : { namespace: "custom", key: s };
                });
        const isMoreDescriptionKey = (key = "") => {
            const n = key.toLowerCase();
            return (
                n.endsWith("more_description") || n.endsWith("moredescription")
            );
        };

        const keys = parseKeys(metafieldKeys || "");
        const mfIndex = keys.findIndex(({ key }) => isMoreDescriptionKey(key));
        if (mfIndex < 0)
            throw new Error("No more_description metafield key configured.");

        const { namespace, key: mfKey } = keys[mfIndex];

        // Resolve actual metafield type from Shopify (first product with plus images)
        let metafieldType = "json"; // fallback
        const firstHandle = Object.entries(allProducts).find(([, prod]) =>
            (prod.media || []).some((m) => m.group === "plus"),
        )?.[0];
        if (firstHandle) {
            try {
                const sample = await client.getProductMediaContext(
                    firstHandle,
                    metafieldKeys,
                );
                const sampleMf = sample?.[`mf_${mfIndex}`];
                if (sampleMf?.type) metafieldType = sampleMf.type;
                console.log(
                    `[PatchPlus] Metafield type resolved: ${metafieldType}`,
                );
            } catch (err) {
                console.warn(
                    `[PatchPlus] Could not resolve metafield type, using 'json':`,
                    err.message,
                );
            }
        }

        // Build expected new filenames from manifest plus group
        const productEntries = [];
        for (const [handle, prod] of Object.entries(allProducts)) {
            const plusFiles = (prod.media || [])
                .filter((m) => m.group === "plus")
                .sort((a, b) => a.position - b.position);
            if (plusFiles.length === 0) continue;

            const plusEntries = plusFiles.map((m, idx) => {
                const order = idx + 1;
                const ext = path.extname(m.filename) || ".jpg";
                const pad = String(order).padStart(2, "0");
                return {
                    order,
                    newFilename: `${handle}-plus-${pad}${ext}`,
                    altFilename: `${handle}-${pad}${ext}`, // fallback for files already renamed without -plus-
                };
            });

            productEntries.push({ handle, productId: prod.id, plusEntries });
        }

        if (productEntries.length === 0)
            return { patched: 0, skipped: 0, failed: 0 };

        // Resolve new CDN URLs by querying Shopify files by new filename
        const allNewFilenames = productEntries.flatMap((p) =>
            p.plusEntries.flatMap((e) => [e.newFilename, e.altFilename]),
        );
        const fileMap = await client.getFilesMetaByFilenames(allNewFilenames);

        const metafieldUpdates = [];
        let skipped = 0;
        const skipLogs = [];

        for (const { handle, productId, plusEntries } of productEntries) {
            const items = plusEntries.map(({ newFilename, altFilename }) => {
                const meta =
                    fileMap.get(newFilename) || fileMap.get(altFilename);
                return meta ? { url: meta.url, alt: meta.alt || "" } : null;
            });

            if (items.some((item) => item === null)) {
                const missing = plusEntries
                    .filter((_, i) => items[i] === null)
                    .map((e) => `${e.newFilename} / ${e.altFilename}`);
                console.warn(
                    `[PatchPlus] Skipping ${handle}: not found: ${missing.join(", ")}`,
                );
                skipLogs.push(
                    `  SKIP ${handle}: not found on Shopify → ${missing.join(", ")}`,
                );
                skipped++;
                continue;
            }

            metafieldUpdates.push({
                ownerId: productId,
                namespace,
                key: mfKey,
                type: metafieldType,
                value: JSON.stringify(items),
            });
        }

        if (metafieldUpdates.length === 0)
            return {
                patched: 0,
                skipped,
                failed: 0,
                logs: [
                    `Metafield type: ${metafieldType}`,
                    `Products to patch: 0`,
                    `Products skipped: ${skipped}`,
                    "",
                    ...skipLogs,
                ],
            };

        // Batch metafield updates (25 per call)
        const MF_BATCH = 25;
        let failed = 0;
        let patched = 0;
        const logs = [
            `Metafield type: ${metafieldType}`,
            `Products to patch: ${metafieldUpdates.length}`,
            `Products skipped: ${skipped}`,
            "",
            ...skipLogs,
            "",
        ];
        for (let i = 0; i < metafieldUpdates.length; i += MF_BATCH) {
            const batch = metafieldUpdates.slice(i, i + MF_BATCH);
            const batchHandles = batch.map(
                (u) =>
                    Object.entries(allProducts).find(
                        ([, p]) => p.id === u.ownerId,
                    )?.[0] || u.ownerId,
            );
            try {
                await client._setMetafields(batch);
                patched += batch.length;
                logs.push(
                    `✓ Batch ${Math.floor(i / MF_BATCH) + 1}: patched [${batchHandles.join(", ")}]`,
                );
            } catch (err) {
                console.error(
                    `[PatchPlus] Metafields batch failed:`,
                    err.message,
                );
                failed += batch.length;
                logs.push(
                    `✗ Batch ${Math.floor(i / MF_BATCH) + 1} FAILED: ${err.message}`,
                );
                logs.push(`  Handles: [${batchHandles.join(", ")}]`);
            }
        }

        return { patched, skipped, failed, logs };
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

    return rows
        .map((r) =>
            r
                .map((cell) => {
                    // Re-quote any cell that contains a tab or newline so it
                    // stays in a single cell when pasted into Excel / Sheets.
                    if (
                        cell.includes("\t") ||
                        cell.includes("\n") ||
                        cell.includes("\r")
                    ) {
                        return `"${cell.replace(/"/g, '""')}"`;
                    }
                    return cell;
                })
                .join("\t"),
        )
        .join("\n");
}

function generateProductsCSV(products) {
    // CSV Headers matching requested Shopify export field order
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
        "More Description (product.metafields.custom.more_description)",
        "Overview (product.metafields.custom.overview)",
        "Product Attachments (product.metafields.custom.product_attachments)",
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
        "Suitable for skin type (product.metafields.shopify.suitable-for-skin-type)",
        "Target gender (product.metafields.shopify.target-gender)",
        "Variant Image",
        "Variant Weight Unit",
        "Variant Tax Code",
        "Cost per item",
        "Status",
        "Variant ID",
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

            const rowByHeader = {
                Handle: product.handle || "",
                Title: product.title || "",
                "Body (HTML)": product.bodyHtml || "",
                Vendor: product.vendor || "",
                "Product Category": product.category?.name || "",
                Type: product.productType || "",
                Tags: Array.isArray(product.tags) ? product.tags.join(",") : "",
                Published: product.publishedAt ? "true" : "false",
                "Option1 Name": options[0]?.name || "",
                "Option1 Value": options[0]?.values?.[variantIdx] || "",
                "Option1 Linked To": "",
                "Option2 Name": options[1]?.name || "",
                "Option2 Value": options[1]?.values?.[variantIdx] || "",
                "Option2 Linked To": "",
                "Option3 Name": options[2]?.name || "",
                "Option3 Value": options[2]?.values?.[variantIdx] || "",
                "Option3 Linked To": "",
                "Variant SKU": variant.sku || "",
                "Variant Grams": "",
                "Variant Inventory Tracker": inventoryItem.tracked
                    ? "shopify"
                    : "",
                "Variant Inventory Qty": variant.inventoryQuantity || 0,
                "Variant Inventory Policy": inventoryItem.tracked ? "deny" : "",
                "Variant Fulfillment Service": "",
                "Variant Price": variant.price || "",
                "Variant Compare At Price": variant.compareAtPrice || "",
                "Variant Requires Shipping": inventoryItem.requiresShipping
                    ? "true"
                    : "false",
                "Variant Taxable": variant.taxable ? "true" : "false",
                "Unit Price Total Measure": "",
                "Unit Price Total Measure Unit": "",
                "Unit Price Base Measure": "",
                "Unit Price Base Measure Unit": "",
                "Variant Barcode": variant.barcode || "",
                "Image Src": imageToUse?.node?.url || "",
                "Image Position": imageToUse ? variantIdx + 1 : "",
                "Image Alt Text": imageToUse?.node?.altText || "",
                "Gift Card": "",
                "SEO Title": getMetafieldValue(product, "seoTitle.value") || "",
                "SEO Description":
                    getMetafieldValue(product, "seoDescription.value") || "",
                "Google Shopping / Google Product Category": "",
                "Google Shopping / Gender": "",
                "Google Shopping / Age Group": "",
                "Google Shopping / MPN": "",
                "Google Shopping / Condition": "",
                "Google Shopping / Custom Product": "",
                "Google Shopping / Custom Label 0": "",
                "Google Shopping / Custom Label 1": "",
                "Google Shopping / Custom Label 2": "",
                "Google Shopping / Custom Label 3": "",
                "Google Shopping / Custom Label 4": "",
                "Also Like (product.metafields.custom.also_like)":
                    getMetafieldValue(product, "mf_0.value") || "",
                "Benefits (product.metafields.custom.benefits)":
                    getMetafieldValue(product, "mf_1.value") || "",
                "Cautions (product.metafields.custom.cautions)":
                    getMetafieldValue(product, "mf_2.value") || "",
                "Collection Name (product.metafields.custom.collection_name)":
                    getMetafieldValue(product, "mf_3.value") || "",
                "Custom Questions (product.metafields.custom.custom_questions)":
                    getMetafieldValue(product, "mf_4.value") || "",
                "Disclaimer (product.metafields.custom.disclaimer)":
                    getMetafieldValue(product, "mf_5.value") || "",
                "How to use (product.metafields.custom.how_to_use)":
                    getMetafieldValue(product, "mf_6.value") || "",
                "Ingredients (product.metafields.custom.ingredients)":
                    getMetafieldValue(product, "mf_7.value") || "",
                "Keywords (product.metafields.custom.keywords)":
                    getMetafieldValue(product, "mf_8.value") || "",
                "Key Features (product.metafields.custom.key_features)":
                    getMetafieldValue(product, "mf_9.value") || "",
                "Key Ingredients & Benefits (product.metafields.custom.key_ingredients_benefits)":
                    getMetafieldValue(product, "mf_10.value") || "",
                "Key Message (product.metafields.custom.key_message)":
                    getMetafieldValue(product, "mf_11.value") || "",
                "Materials (product.metafields.custom.materials)":
                    getMetafieldValue(product, "mf_12.value") || "",
                "More Description (product.metafields.custom.more_description)":
                    getMetafieldValue(product, "mf_13.value") || "",
                "Overview (product.metafields.custom.overview)":
                    getMetafieldValue(product, "mf_14.value") || "",
                "Product Attachments (product.metafields.custom.product_attachments)":
                    getMetafieldValue(product, "mf_15.value") || "",
                "question_answers (product.metafields.custom.question_answers)":
                    getMetafieldValue(product, "mf_16.value") || "",
                "Short Title (product.metafields.custom.short_title)":
                    getMetafieldValue(product, "mf_17.value") || "",
                "Suitable For Skin Type (product.metafields.custom.suitable_for_skin_type)":
                    getMetafieldValue(product, "mf_18.value") || "",
                "User Review (product.metafields.custom.user_review)":
                    getMetafieldValue(product, "mf_19.value") || "",
                "Use It With (product.metafields.custom.use_it_with)":
                    getMetafieldValue(product, "mf_20.value") || "",
                "Youtube Video Links (product.metafields.custom.youtube_video_links)":
                    getMetafieldValue(product, "mf_21.value") || "",
                "Google: Custom Product (product.metafields.mm-google-shopping.custom_product)":
                    getMetafieldValue(
                        product,
                        "metafieldGoogleProduct.value",
                    ) || "",
                "Fragrance (product.metafields.shopify.fragrance)":
                    getMetafieldValue(product, "metafieldFragrance.value") ||
                    "",
                "Moisturizer type (product.metafields.shopify.moisturizer-type)":
                    getMetafieldValue(
                        product,
                        "metafieldMoisturizerType.value",
                    ) || "",
                "Product form (product.metafields.shopify.product-form)":
                    getMetafieldValue(product, "metafieldProductForm.value") ||
                    "",
                "Suitable for skin type (product.metafields.shopify.suitable-for-skin-type)":
                    getMetafieldValue(
                        product,
                        "metafieldSuitableForSkinType.value",
                    ) || "",
                "Target gender (product.metafields.shopify.target-gender)":
                    getMetafieldValue(product, "metafieldTargetGender.value") ||
                    "",
                "Variant Image": variant.image?.url || "",
                "Variant Weight Unit": "",
                "Variant Tax Code": variant.taxCode || "",
                "Cost per item": "",
                Status: product.status || "",
                "Variant ID":
                    variant.legacyResourceId ||
                    (variant.id ? variant.id.split("/").pop() : ""),
            };

            const row = headers.map((header) => rowByHeader[header] || "");
            rows.push(row.map(escapeCSV).join(","));
        });
    });

    // Combine headers and rows
    return [headers.map(escapeCSV).join(","), ...rows].join("\n");
}
