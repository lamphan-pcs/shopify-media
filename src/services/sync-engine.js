const path = require("path");
const fs = require("fs-extra");
const { createObjectCsvWriter } = require("csv-writer");
const ShopifyClient = require("./shopify-client");
const ManifestManager = require("../utils/manifest-manager");
const Downloader = require("./downloader");

class SyncEngine {
    constructor(config) {
        this.config = config; // { shopUrl, apiKey, downloadPath, initialSync: boolean }
        this.manifest = new ManifestManager(config.downloadPath);
        this.shopify = new ShopifyClient(config.shopUrl, config.apiKey);
        this.downloader = new Downloader(100); // Set concurrency
        this.changes = [];
        this.detailedResults = []; // Store full product state for UI
    }

    async run(onProgress) {
        await this.manifest.load();

        // 1. Validate
        onProgress({ message: "Connecting to Shopify...", percent: 5 });
        try {
            await this.shopify.validateConnection();
        } catch (e) {
            throw new Error("Connection Failed: " + e.message);
        }

        // 2. Fetch Logic
        let allProducts = [];
        let hasNext = true;
        let cursor = null;
        let lastSync =
            this.config.initialSync || this.config.forceFullSync
                ? null
                : this.manifest.getLastSync();

        if (this.config.forceFullSync) {
            console.log(
                "Force Full Sync enabled: Ignoring last sync timestamp.",
            );
        }

        onProgress({ message: "Fetching Products...", percent: 10 });

        while (hasNext) {
            const data = await this.shopify.fetchProducts(
                lastSync,
                cursor,
                this.config.metafieldKeys,
            );
            const edges = data.products.edges;
            allProducts = allProducts.concat(edges.map((e) => e.node));

            hasNext = data.products.pageInfo.hasNextPage;
            cursor = data.products.pageInfo.endCursor;

            onProgress({
                message: `Fetched ${allProducts.length} products...`,
                percent: 15,
            });
        }

        // 3. Diffing
        onProgress({ message: "Calculating Differences...", percent: 20 });
        const downloadQueue = [];
        const processedHandles = new Set();
        const currentTimestamp = new Date().toISOString();

        // Prepare Metafield Parsing
        const mfMap = {};
        if (this.config.metafieldKeys) {
            console.log(
                "Configuring Metafields with keys:",
                this.config.metafieldKeys,
            );
            this.config.metafieldKeys.split(",").forEach((k, i) => {
                const standardized = k.trim().toLowerCase();
                mfMap[`mf_${i}`] = standardized;
                console.log(`Mapped mf_${i} -> ${standardized}`);
            });
        }

        const getSpecialFilename = (url, prefix) => {
            const cleanUrl = url.split("?")[0];
            let filename = path.basename(decodeURIComponent(cleanUrl));
            // Keep alphanumeric, dots, dashes, underscores, spaces, parenthesis
            filename = filename.replace(/[^a-zA-Z0-9\.\-\_\(\) ]/g, "");
            if (!filename.trim()) filename = "unnamed.jpg";
            return `${prefix}${filename}`;
        };

        const isMoreDescriptionMetafield = (metafieldName = "") => {
            const normalized = String(metafieldName || "")
                .trim()
                .toLowerCase();

            return (
                normalized.endsWith("more_description") ||
                normalized.endsWith("moredescription")
            );
        };

        const extractJsonImageUrls = (rawValue) => {
            if (!rawValue || typeof rawValue !== "string") return [];

            try {
                const parsed = JSON.parse(rawValue);
                if (!Array.isArray(parsed)) return [];

                return parsed
                    .map((item) => {
                        if (typeof item === "string") {
                            return { url: item, alt: "" };
                        }

                        if (item && typeof item === "object") {
                            const url =
                                typeof item.url === "string"
                                    ? item.url
                                    : typeof item.src === "string"
                                      ? item.src
                                      : "";

                            return {
                                url,
                                alt:
                                    typeof item.alt === "string"
                                        ? item.alt
                                        : "",
                            };
                        }

                        return { url: "", alt: "" };
                    })
                    .filter((item) => item.url);
            } catch (error) {
                console.warn(
                    `[Diff] Skipping invalid JSON metafield value. Error: ${error.message}`,
                );
                return [];
            }
        };

        for (const remoteProd of allProducts) {
            processedHandles.add(remoteProd.handle);
            const handle = remoteProd.handle;
            const firstSku = remoteProd.variants?.edges?.[0]?.node?.sku;
            const folderName = (
                firstSku ? `${handle}-${firstSku}` : handle
            ).toLowerCase();
            const destFolder = path.join(this.config.downloadPath, folderName);

            const localProd = this.manifest.getProduct(handle);
            const localMediaMap = this.manifest.getMediaMap(handle);

            const newMediaList = []; // New state for manifest
            const displayMedia = []; // For UI Gallery
            let productActionOccurred = false;

            // 1. Gather all targets with specific types
            const targets = [];

            // A. Check Metafields (Banners & Extras)
            Object.keys(remoteProd).forEach((key) => {
                // Only look at mf_ prefixed keys details
                if (!key.startsWith("mf_")) return;

                const node = remoteProd[key];
                const rawName = mfMap[key]; // e.g. "image_list_1"

                // console.log(`[Diff] Inspecting ${key} -> ${rawName}. Value:`, node ? node.id : 'null');

                if (node && rawName) {
                    const mfName = rawName.toLowerCase();

                    // BannerOne
                    if (
                        mfName.endsWith("bannerone") ||
                        mfName.endsWith("banner_1")
                    ) {
                        const url =
                            node.reference?.image?.originalSrc ||
                            node.reference?.originalSrc;
                        const _fileId =
                            node.reference?.image?.id ||
                            node.reference?.id ||
                            node.id;
                        if (url) {
                            targets.push({
                                id: node.reference?.id || node.id,
                                _fileId: _fileId,
                                url: url,
                                typeGroup: "banner",
                            });
                        }
                    }
                    // ImageListOne
                    else if (
                        mfName.endsWith("imagelistone") ||
                        mfName.endsWith("image_list_1")
                    ) {
                        // Single Reference (if list used as single?)
                        if (node.reference) {
                            const url =
                                node.reference.image?.originalSrc ||
                                node.reference.originalSrc;
                            const _fileId =
                                node.reference.image?.id ||
                                node.reference.id ||
                                node.id;
                            if (url) {
                                targets.push({
                                    id: node.reference.id || node.id,
                                    _fileId: _fileId,
                                    url,
                                    typeGroup: "extra",
                                });
                            }
                        }
                        // List References
                        if (node.references && node.references.edges) {
                            node.references.edges.forEach((edge) => {
                                const n = edge.node;
                                const url =
                                    n.image?.originalSrc || n.originalSrc;
                                if (url) {
                                    targets.push({
                                        id: n.id,
                                        _fileId: n.image?.id || n.id,
                                        url,
                                        typeGroup: "extra",
                                    });
                                }
                            });
                        }
                    }
                    // JSON image array (e.g. more_description)
                    else if (isMoreDescriptionMetafield(mfName)) {
                        const jsonImages = extractJsonImageUrls(node.value);
                        jsonImages.forEach((img, idx) => {
                            const cleanUrl = img.url.split("?")[0];
                            const syntheticId = `meta-json:${node.id || mfName}:${idx}:${cleanUrl}`;

                            targets.push({
                                id: syntheticId,
                                _fileId: syntheticId,
                                url: img.url,
                                typeGroup: "plus",
                            });
                        });
                    }
                }
            });

            // B. Check Main Media
            remoteProd.media.edges.forEach((edge) => {
                const m = edge.node;
                let url = null;
                let type = "unknown";

                if (m.mediaContentType === "IMAGE") {
                    url = m.image.originalSrc;
                    type = "image";
                } else if (m.mediaContentType === "VIDEO") {
                    const src = m.sources.find(
                        (s) => s.mimeType === "video/mp4",
                    );
                    url = src ? src.url : null;
                    type = "video";
                }

                if (url) {
                    // Skip main media explicitly if filename ends with _pri (before extension)
                    const cleanUrlForCheck = url.split("?")[0];
                    const filenameForCheck = path.basename(
                        decodeURIComponent(cleanUrlForCheck),
                    );
                    const extForCheck = path.extname(filenameForCheck);
                    const nameWithoutExt = path.basename(
                        filenameForCheck,
                        extForCheck,
                    );

                    // if (nameWithoutExt.endsWith("_pri")) {
                    //     // console.log(`[Diff] Skipping _pri image: ${filenameForCheck}`);
                    //     return;
                    // }

                    targets.push({
                        id: m.id,
                        _fileId: m.image ? m.image.id : m.id,
                        url: url,
                        typeGroup: "main",
                        originalType: type,
                    });
                }
            });

            // 2. Assign Filenames & Sort
            // Requested Order: Main (skip _pri), then Banner, then Extras.

            let extraCounter = 0;
            let plusCounter = 0;
            let mainCounter = 0;

            const finalMediaList = [];

            // Process Main
            targets
                .filter((t) => t.typeGroup === "main")
                .forEach((t) => {
                    // Skip logic: if filename ends with _pri before extension
                    // Extract raw filename from URL
                    const rawName = path.basename(t.url.split("?")[0]);
                    const rawNameNoExt = path.parse(rawName).name;

                    // if (rawNameNoExt.endsWith("_pri")) {
                    //     return; // Skip
                    // }

                    mainCounter++;
                    const prefix = `main-${String(mainCounter).padStart(
                        2,
                        "0",
                    )}-`;
                    const filename = getSpecialFilename(t.url, prefix);
                    finalMediaList.push({ ...t, filename, position: 1 });
                });

            // Process Banners
            targets
                .filter((t) => t.typeGroup === "banner")
                .forEach((t) => {
                    const filename = getSpecialFilename(t.url, "banner-");
                    finalMediaList.push({ ...t, filename, position: 1 });
                });

            // Process Extras
            targets
                .filter((t) => t.typeGroup === "extra")
                .forEach((t) => {
                    extraCounter++;
                    const prefix = `extra-${String(extraCounter).padStart(
                        2,
                        "0",
                    )}-`;
                    const filename = getSpecialFilename(t.url, prefix);
                    finalMediaList.push({ ...t, filename, position: 1 });
                });

            // Process Plus (e.g. custom.more_description JSON image list)
            targets
                .filter((t) => t.typeGroup === "plus")
                .forEach((t) => {
                    plusCounter++;
                    const prefix = `plus-${String(plusCounter).padStart(
                        2,
                        "0",
                    )}-`;
                    const filename = getSpecialFilename(t.url, prefix);
                    finalMediaList.push({ ...t, filename, position: 1 });
                });

            // 3. Diff & Download Loop
            let positionCounter = 0;
            for (const media of finalMediaList) {
                positionCounter++;
                let filename = media.filename;
                const url = media.url;
                const type = media.originalType || "image"; // Default to image for banners/extras

                // Diff Logic
                let status = "unchanged";
                // Look up by composite "id:group" so the same Shopify GID used
                // in multiple groups (main, banner, extra) resolves independently.
                const localMedia = localMediaMap.get(
                    `${media.id}:${media.typeGroup || ""}`,
                );

                if (!localMedia) {
                    // NEW
                    status = "new";
                    downloadQueue.push({
                        url,
                        destPath: path.join(destFolder, filename),
                    });
                    this.changes.push({
                        product: handle,
                        type: "NEW_ASSET",
                        file: filename,
                    });
                } else if (
                    media._fileId &&
                    localMedia._fileId &&
                    media._fileId !== localMedia._fileId
                ) {
                    // Content updated — download to the newly computed filename
                    status = "updated";
                    downloadQueue.push({
                        url,
                        destPath: path.join(destFolder, filename),
                    });
                    this.changes.push({
                        product: handle,
                        type: "UPDATED_ASSET",
                        file: filename,
                    });
                } else {
                    // Same content (_fileId matches or unknown).
                    // Keep the existing filename regardless of computed name — position-counter
                    // shifts (due to API ordering variance or items added elsewhere) must not
                    // trigger re-downloads or false REORDERED reports.
                    filename = localMedia.filename;
                }

                const destFile = path.join(destFolder, filename);

                newMediaList.push({
                    id: media.id,
                    _fileId: media._fileId,
                    filename: filename,
                    position: positionCounter,
                    type: type,
                    lastStatus: status, // PERSIST STATUS TO MANIFEST
                    group: media.typeGroup, // PERSIST GROUP TO MANIFEST
                });

                // Check if file physically exists, if not download again
                if (
                    status === "unchanged" &&
                    !(await fs.pathExists(destFile))
                ) {
                    downloadQueue.push({ url, destPath: destFile });
                    status = "restored";
                }

                if (status !== "unchanged") productActionOccurred = true;

                displayMedia.push({
                    src: destFile,
                    filename: filename,
                    status: status,
                    type: type,
                    group: media.typeGroup,
                });
            }

            // Check for Deleted (Items in manifest not in current finalMediaList)
            if (localMediaMap.size > 0) {
                // Use composite keys so a GID that moved groups is deleted from
                // the old group entry rather than kept as a false match.
                const currentKeys = new Set(
                    newMediaList.map((m) => `${m.id}:${m.group || ""}`),
                );

                for (const [key, val] of localMediaMap) {
                    if (!currentKeys.has(key)) {
                        this.changes.push({
                            product: handle,
                            type: "DELETED_ASSET",
                            file: val.filename,
                        });

                        // Strict Mirroring
                        if (!this.config.dryRun) {
                            const fileToDelete = path.join(
                                destFolder,
                                val.filename,
                            );
                            try {
                                if (await fs.pathExists(fileToDelete)) {
                                    await fs.remove(fileToDelete);
                                }
                            } catch (err) {
                                console.error(
                                    `Failed to delete ${fileToDelete}`,
                                    err,
                                );
                            }
                        }
                    }
                }
            }

            // Detect Reordering
            // Compare the ID sequence of newMediaList vs localProd.media
            if (localProd && localProd.media) {
                // Compare using composite "id:group" keys so a same-GID
                // multi-group image doesn't trigger false reorder detections.
                const oldIds = localProd.media
                    .map((m) => `${m.id}:${m.group || ""}`)
                    .join(",");
                const newIds = newMediaList
                    .map((m) => `${m.id}:${m.group || ""}`)
                    .join(",");
                if (oldIds !== newIds && oldIds.length > 0) {
                    this.changes.push({
                        product: handle,
                        type: "REORDERED",
                        file: "Gallery Order Changed",
                    });
                }
            }

            // Extract Metadata (SKU, Category, Tags)
            const targetTags = [
                "skin-science",
                "cosmetic-and-glam",
                "masks-and-patches",
                "makeup-tools-and-brushes",
                "care-tools-and-brushes",
                "hair-and-body-care",
                "lash-collections",
                "beauty-devices",
                "hair-accessories",
                "pro-and-diy-nail",
                "kid-product",
                "ruby-vibe-co-gift-set",
            ];

            let category = "Uncategorized";
            if (remoteProd.tags) {
                // Find first tag that matches our target list
                const foundTag = remoteProd.tags.find((t) =>
                    targetTags.includes(t),
                );
                if (foundTag) category = foundTag;
            }

            const skus =
                remoteProd.variants?.edges
                    ?.map((e) => e.node.sku)
                    .filter(Boolean)
                    .join(", ") || "";

            // Update Manifest Data for this product
            this.manifest.updateProduct(handle, {
                id: remoteProd.id,
                title: remoteProd.title,
                tags: remoteProd.tags || [],
                category: category,
                sku: skus,
                folderName: folderName, // store resolved folder name for cleanup lookup
                updated_at: currentTimestamp, // local sync time
                media: newMediaList,
            });

            // Populate Detailed Results for UI if changes occurred
            if (
                productActionOccurred ||
                this.changes.some(
                    (c) => c.product === handle && c.type === "DELETED_ASSET",
                )
            ) {
                this.detailedResults.push({
                    title: remoteProd.title,
                    handle: handle,
                    media: displayMedia,
                });
            }
        }

        // 4. Execution
        if (downloadQueue.length > 0) {
            if (this.config.dryRun) {
                onProgress({
                    message: `Simulation: Skiping ${downloadQueue.length} downloads...`,
                    percent: 50,
                });
            } else {
                onProgress({
                    message: `Downloading ${downloadQueue.length} files...`,
                    percent: 30,
                });
                await this.downloader.downloadQueue(
                    downloadQueue,
                    (completed, total, item) => {
                        const pct = 30 + Math.floor((completed / total) * 60); // 30-90%
                        onProgress({
                            message: `Downloading (${completed}/${total})`,
                            percent: pct,
                        });
                    },
                );
            }
        }

        // 5. Cleanup / Report
        onProgress({ message: "Finalizing...", percent: 95 });

        if (!this.config.dryRun) {
            this.manifest.setLastSync(currentTimestamp);
            await this.manifest.save();
            // Auto-clean orphaned local files that are no longer in the manifest
            await this._cleanupOrphanedFiles(onProgress);
        }

        await this._generateReport(); // Create CSV

        onProgress({ message: "Complete", percent: 100 });

        return {
            changes: this.changes,
            updatedProducts: this.detailedResults,
            updatedCount: allProducts.length,
            downloadCount: downloadQueue.length,
        };
    }

    async _cleanupOrphanedFiles(onProgress) {
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
        const mediaRegex = /\.(jpg|jpeg|png|gif|mp4|mov|webp)$/i;
        const allProducts = this.manifest.getAllProducts();

        // Build folderName → valid filenames map
        const validByFolder = new Map();
        for (const product of Object.values(allProducts)) {
            const key = product.folderName || product.handle;
            if (!key) continue;
            validByFolder.set(
                key,
                new Set((product.media || []).map((m) => m.filename)),
            );
        }

        let deleted = 0;
        let entries;
        try {
            entries = await fs.readdir(this.config.downloadPath, {
                withFileTypes: true,
            });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".")) continue;
            if (ignoredFolders.has(entry.name)) continue;

            const productPath = path.join(this.config.downloadPath, entry.name);
            const validFilenames = validByFolder.get(entry.name) || new Set();

            let files;
            try {
                files = await fs.readdir(productPath);
            } catch {
                continue;
            }

            for (const file of files) {
                if (!mediaRegex.test(file)) continue;
                if (!validFilenames.has(file)) {
                    try {
                        await fs.remove(path.join(productPath, file));
                        deleted++;
                    } catch (err) {
                        console.error(
                            `[Cleanup] Failed to remove ${file}: ${err.message}`,
                        );
                    }
                }
            }
        }

        if (deleted > 0) {
            console.log(`[Cleanup] Auto-removed ${deleted} orphaned file(s).`);
        }
    }

    async _generateReport() {
        if (this.changes.length === 0) return;

        const reportPath = path.join(
            this.config.downloadPath,
            `sync_report_${Date.now()}.csv`,
        );
        const csvWriter = createObjectCsvWriter({
            path: reportPath,
            header: [
                { id: "product", title: "Product Handle" },
                { id: "type", title: "Change Type" },
                { id: "file", title: "File / Detail" },
                { id: "time", title: "Timestamp" },
            ],
        });

        const records = this.changes.map((c) => ({
            ...c,
            time: new Date().toISOString(),
        }));

        await csvWriter.writeRecords(records);
        return reportPath;
    }
}

module.exports = SyncEngine;
