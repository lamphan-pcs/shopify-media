const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
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
