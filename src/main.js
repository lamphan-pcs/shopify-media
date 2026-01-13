const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const SyncEngine = require("./services/sync-engine");
const ManifestManager = require("./utils/manifest-manager");

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
                !dirent.name.startsWith(".")
        );
        console.log(
            `[Scan] Found ${productFolders.length} candidate product folders.`
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
                            /\.(jpg|jpeg|png|gif|mp4|mov|webp)$/i.test(file)
                        );
                } catch (err) {
                    console.log(
                        `[Scan] Error accessing ${folder.name}: ${err.message}`
                    );
                    return null;
                }

                if (files.length === 0) {
                    console.log(
                        `[Scan] Folder ${folder.name} has no media files. Skipping.`
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
        `[IPC] Physical Scan found ${physicalProducts.length} products`
    );

    // 2. Load Manifest for Metadata Overlay (Optional)
    const manifest = new ManifestManager(folderPath);
    await manifest.load();
    const manifestProducts = manifest.getAllProducts();

    // 3. Enhance physical results with manifest data if available
    const enhancedResults = physicalProducts.map((p) => {
        const tracked = manifestProducts[p.handle];
        if (tracked) {
            // Merge metadata from manifest
            p.sku = tracked.sku || "";
            p.category = tracked.category || "";
            p.tags = tracked.tags || [];

            p.media = p.media.map((m) => {
                const knownFile = tracked.media.find(
                    (tm) => tm.filename === m.filename
                );
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
