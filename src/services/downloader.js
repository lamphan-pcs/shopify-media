const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const stream = require("stream");
const { promisify } = require("util");
const pipeline = promisify(stream.pipeline);

class Downloader {
    constructor(concurrency = 20) {
        this.concurrency = concurrency;
    }

    async downloadQueue(items, onProgress) {
        // Dynamic import for p-limit since it's an ESM package in newer versions
        // If we are using CommonJS, we might need a workaround or use an older version.
        // For simplicity in this environment, assuming standard require works or I'll implement a simple semaphore.
        let limit;
        try {
            const pLimit = (await import("p-limit")).default;
            limit = pLimit(this.concurrency);
        } catch (e) {
            // Fallback for CommonJS if ESM import fails unexpectedly
            limit = (fn) => fn();
            // NOTE: In a real app, ensure p-limit version matches module system.
            // I'll assume usage of v3.1.0 which is CommonJS safe usually, but let's write a simple limiter just in case
            // to avoid module headaches in this scaffold.
            limit = this._simpleLimit(this.concurrency);
        }

        let completed = 0;
        const total = items.length;

        const promises = items.map((item) =>
            limit(async () => {
                try {
                    await this.downloadFile(item.url, item.destPath);
                    completed++;
                    if (onProgress) onProgress(completed, total, item);
                    return { status: "success", item };
                } catch (error) {
                    console.error(
                        `Failed to download ${item.url}:`,
                        error.message
                    );
                    return { status: "error", item, error: error.message };
                }
            })
        );

        return Promise.all(promises);
    }

    _simpleLimit(concurrency) {
        const queue = [];
        let active = 0;

        const next = () => {
            if (active >= concurrency || queue.length === 0) return;
            active++;
            const { fn, resolve, reject } = queue.shift();
            fn()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    active--;
                    next();
                });
        };

        return (fn) =>
            new Promise((resolve, reject) => {
                queue.push({ fn, resolve, reject });
                next();
            });
    }

    async downloadFile(url, destPath) {
        // Create temp path
        const tempPath = `${destPath}.tmp`;

        await fs.ensureDir(path.dirname(destPath));

        try {
            const response = await axios({
                method: "GET",
                url: url,
                responseType: "stream",
                timeout: 30000,
            });

            await pipeline(response.data, fs.createWriteStream(tempPath));

            // Rename successful temp file to actual file
            await fs.move(tempPath, destPath, { overwrite: true });
        } catch (err) {
            if (fs.existsSync(tempPath)) {
                await fs.remove(tempPath);
            }
            throw err;
        }
    }
}

module.exports = Downloader;
