const fs = require("fs");
const path = require("path");

// --- MOCK FUNCTION FROM main.js ---
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
            `[Scan] Found ${
                productFolders.length
            } candidate product folders: ${productFolders
                .map((f) => f.name)
                .join(", ")}`
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
// --- END MOCK FUNCTION ---

// Setup Test Environment
const testDir = path.join(__dirname, "test_library");
if (fs.existsSync(testDir))
    fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir);

// Case 1: Valid Product
const prod1 = path.join(testDir, "blue-shirt");
fs.mkdirSync(prod1);
fs.writeFileSync(path.join(prod1, "front.jpg"), "fake-image-content");
fs.writeFileSync(path.join(prod1, "back.png"), "fake-image-content");

// Case 2: Empty Product Folder
const prod2 = path.join(testDir, "empty-product");
fs.mkdirSync(prod2);

// Case 3: Ignored Folder
const ignored = path.join(testDir, "node_modules");
fs.mkdirSync(ignored);
fs.writeFileSync(path.join(ignored, "pkg.jpg"), "should-not-be-scanned");

// Case 4: File in root (should be ignored)
fs.writeFileSync(path.join(testDir, "root-image.jpg"), "ignore-me");

console.log("--- STARTING TEST ---");
const results = scanDirectoryForProducts(testDir);
console.log("--- RESULTS ---");
console.log(JSON.stringify(results, null, 2));

// Cleanup
// fs.rmSync(testDir, { recursive: true, force: true });
