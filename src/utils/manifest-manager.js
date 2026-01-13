const fs = require("fs-extra");
const path = require("path");

class ManifestManager {
    constructor(rootPath) {
        this.rootPath = rootPath;
        this.manifestPath = path.join(rootPath, "manifest.json");
        this.data = this._getEmptyState();
    }

    _getEmptyState() {
        return {
            last_synced: null,
            products: {},
            // Structure:
            // products: {
            //   [handle]: {
            //      id: 123,
            //      updated_at: "...",
            //      media: [ { id, filename, position } ]
            //   }
            // }
        };
    }

    async load() {
        try {
            if (await fs.pathExists(this.manifestPath)) {
                this.data = await fs.readJson(this.manifestPath);
            } else {
                this.data = this._getEmptyState();
                // Ensure root directory exists
                await fs.ensureDir(this.rootPath);
            }
        } catch (error) {
            console.error("Failed to load manifest:", error);
            // Default to empty if corrupt
            this.data = this._getEmptyState();
        }
    }

    async save() {
        try {
            // Create a backup of the current manifest before overwriting
            if (await fs.pathExists(this.manifestPath)) {
                const backupsDir = path.join(
                    this.rootPath,
                    ".manifest_history"
                );
                await fs.ensureDir(backupsDir);

                // Use a timestamp for the backup filename
                const timestamp = new Date()
                    .toISOString()
                    .replace(/[:.]/g, "-");
                const backupPath = path.join(
                    backupsDir,
                    `manifest-${timestamp}.json`
                );

                await fs.copy(this.manifestPath, backupPath);
                console.log(`Backed up manifest to ${backupPath}`);
            }

            await fs.writeJson(this.manifestPath, this.data, { spaces: 2 });
        } catch (error) {
            console.error("Failed to save manifest:", error);
        }
    }

    getProduct(handle) {
        return this.data.products[handle] || null;
    }

    getAllProducts() {
        return this.data.products;
    }

    updateProduct(handle, productData) {
        // Ensure handle is stored in data if needed for reverse lookup
        productData.handle = handle;
        this.data.products[handle] = productData;
    }

    setLastSync(dateIsoString) {
        this.data.last_synced = dateIsoString;
    }

    getLastSync() {
        return this.data.last_synced;
    }

    // Helper to get a map of media ID -> file info for quick diffing
    getMediaMap(handle) {
        const product = this.getProduct(handle);
        const map = new Map();
        if (product && product.media) {
            product.media.forEach((m) => map.set(m.id, m));
        }
        return map;
    }
}

module.exports = ManifestManager;
