const { ipcRenderer } = require("electron");
const path = require("path"); // Load path module at top level

let selectedPath = localStorage.getItem("lastPath") || "";
document.getElementById("pathDisplay").value = selectedPath;
document.getElementById("shopUrl").value =
    localStorage.getItem("lastShop") || "";
document.getElementById("apiKey").value = localStorage.getItem("lastKey") || "";
document.getElementById("metafields").value =
    localStorage.getItem("lastMetafields") || "";

async function selectFolder() {
    selectedPath = await ipcRenderer.invoke("select-folder");
    if (selectedPath) {
        document.getElementById("pathDisplay").value = selectedPath;
        localStorage.setItem("lastPath", selectedPath);
        // Do NOT auto load into dashboard anymore, just ready state
    }
}

// Initial Load
if (selectedPath) {
    // Optional: Preload library in background or wait for tab switch
    console.log("Auto-loading library on startup...");
    // Force switch to library tab for debugging if preferred, or just load data
    // loadLocalLibrary(true); // Uncomment to force load on startup
}

function switchTab(tabName) {
    console.log(`[UI] Switching to tab: ${tabName}`);
    try {
        // 1. Reset Buttons
        document
            .querySelectorAll(".tab-btn")
            .forEach((b) => b.classList.remove("active"));

        // 2. Hide All Content explicitly
        document.querySelectorAll(".tab-content").forEach((c) => {
            c.classList.remove("active");
            c.style.display = "none"; // Force hide
        });

        // 3. Activate Target Button
        const buttons = document.querySelectorAll(".tab-btn");
        // Find button by text content to be sure
        buttons.forEach((btn) => {
            if (
                btn.innerText
                    .toLowerCase()
                    .includes(tabName === "dashboard" ? "dashboard" : "library")
            ) {
                btn.classList.add("active");
            }
        });

        // 4. Activate Target Content explicitly
        const activeTab = document.getElementById(`tab-${tabName}`);
        if (activeTab) {
            activeTab.classList.add("active");
            activeTab.style.display = "block"; // Force show
            console.log(`[UI] Tab ${tabName} activated.`);

            // Force redraw of children
            activeTab.offsetHeight;
        } else {
            alert(`[UI] Tab element tab-${tabName} not found!`);
        }

        // 5. Trigger Logic
        if (tabName === "library") {
            // Slight delay to ensure DOM is painted
            setTimeout(() => {
                console.log("Triggering loadLocalLibrary from switchTab");
                loadLocalLibrary(true);
            }, 50);
        }
    } catch (e) {
        console.error("Error in switchTab:", e);
        alert("Error switching tab: " + e.message);
    }
}

let cachedLibrary = [];

async function loadLocalLibrary(renderToLibraryTab = false) {
    console.log("Loading Local Library from:", selectedPath);
    if (!selectedPath) {
        if (renderToLibraryTab) {
            document.getElementById("fullLibraryArea").innerHTML =
                '<div style="padding:20px; text-align:center;">Please select a folder first.</div>';
        }
        return;
    }

    try {
        const products = await ipcRenderer.invoke("load-library", selectedPath);
        console.log("Loaded products:", products ? products.length : "null");
        cachedLibrary = products || [];

        if (renderToLibraryTab) {
            renderGallery(cachedLibrary, "fullLibraryArea");
        }
    } catch (e) {
        console.error("Failed to load local library", e);
        if (renderToLibraryTab) {
            document.getElementById(
                "fullLibraryArea"
            ).innerHTML = `<div style="color:red; padding:20px;">Error loading library: ${e.message}</div>`;
        }
    }
}

function filterLibrary() {
    const query = document.getElementById("libSearch").value.toLowerCase();
    const category = document
        .getElementById("categoryFilter")
        .value.toLowerCase();

    const filtered = cachedLibrary.filter((p) => {
        // 1. Matches Search Text
        const matchesText =
            (p.title && p.title.toLowerCase().includes(query)) ||
            (p.handle && p.handle.toLowerCase().includes(query)) ||
            (p.sku && p.sku.toLowerCase().includes(query)) ||
            (p.tags && p.tags.some((t) => t.toLowerCase().includes(query)));

        // 2. Matches Category Dropdown (Exact match on stored category OR check tags if category field missing)
        let matchesCategory = true;
        if (category) {
            matchesCategory =
                (p.category && p.category.toLowerCase() === category) ||
                (p.tags && p.tags.includes(category));
        }

        return matchesText && matchesCategory;
    });
    renderGallery(filtered, "fullLibraryArea");
}

ipcRenderer.on("sync-progress", (event, data) => {
    const area = document.getElementById("progressArea");
    const fill = document.getElementById("progFill");
    const text = document.getElementById("statusText");

    area.style.display = "block";
    fill.style.width = data.percent + "%";
    text.innerText = `${data.message} (${data.percent}%)`;
});

async function startSync() {
    console.log("startSync clicked");
    try {
        const shopUrlInput = document.getElementById("shopUrl");
        const apiKeyInput = document.getElementById("apiKey");
        const metafieldsInput = document.getElementById("metafields");
        const dryRunInput = document.getElementById("dryRun");

        if (!shopUrlInput || !apiKeyInput || !metafieldsInput || !dryRunInput) {
            throw new Error(
                "Critical UI Error: One or more input fields are missing from the DOM."
            );
        }

        const shopUrl = shopUrlInput.value;
        const apiKey = apiKeyInput.value;
        const metafields = metafieldsInput.value;
        const dryRun = dryRunInput.checked;

        console.log("Config loaded", { shopUrl, dryRun });

        if (!shopUrl || !apiKey || !selectedPath) {
            return alert(
                "Please complete all configuration fields (Shop URL, API Key, and Folder)."
            );
        }

        // Save config
        localStorage.setItem("lastShop", shopUrl);
        localStorage.setItem("lastKey", apiKey);
        localStorage.setItem("lastMetafields", metafields);

        const btn = document.getElementById("syncBtn");
        btn.disabled = true;
        const originalText = btn.innerText;
        btn.innerText = dryRun ? "CHECKING..." : "SYNCING...";

        document.getElementById("resultsArea").style.display = "none";
        document.getElementById("errorArea").style.display = "none";

        const config = {
            shopUrl,
            apiKey,
            downloadPath: selectedPath,
            metafieldKeys: metafields,
            dryRun,
        };
        console.log("Invoking IPC start-sync");
        const results = await ipcRenderer.invoke("start-sync", config);
        renderResults(results);
    } catch (err) {
        console.error("Sync Error:", err);
        // Show copyable error
        const errDiv = document.getElementById("errorArea");
        const errMsg = document.getElementById("errorMsg");
        if (errDiv && errMsg) {
            errDiv.style.display = "block";
            errMsg.innerText =
                "Error in startSync: " + (err.stack || err.message);
        } else {
            alert("Critical Error: " + err.message);
        }
    } finally {
        const btn = document.getElementById("syncBtn");
        if (btn) {
            btn.disabled = false;
            // Restore text based on checkbox state to be neat
            const dryRun = document.getElementById("dryRun")
                ? document.getElementById("dryRun").checked
                : true;
            btn.innerText = "CHECK FOR UPDATES";
        }
    }
}

function renderResults(data) {
    document.getElementById("resultsArea").style.display = "block";
    document.getElementById("statProducts").innerText = data.updatedCount;
    document.getElementById("statDownloads").innerText = data.downloadCount;
    document.getElementById("statChanges").innerText = data.changes.length;

    const tbody = document.getElementById("logBody");
    tbody.innerHTML = "";

    if (data.changes.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="3" style="text-align:center; padding: 20px;">No changes detected. Your local library is up to date.<br><br><button onclick="switchTab(\'library\')" style="padding:8px 16px; background:#f1f2f3; color:#333; border:1px solid #ccc; cursor:pointer;">View Full Library</button></td></tr>';
        document.getElementById("galleryArea").innerHTML = ""; // Clear gallery
        return;
    }

    data.changes.forEach((c) => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${c.product}</td>
            <td><span class="badge badge-${c.type}">${c.type.replace(
            "_",
            " "
        )}</span></td>
            <td>${c.file}</td>
        `;
        tbody.appendChild(row);
    });

    // Render Gallery for Updated Products
    renderGallery(data.updatedProducts, "galleryArea");
}

function openProductFolder(folderPath) {
    if (!folderPath) return;
    ipcRenderer.invoke("open-folder", folderPath);
}

function renderGallery(products, containerId, showAll = false) {
    console.log(
        `[renderGallery] Called with ${
            products?.length || 0
        } products for #${containerId}`
    );

    const container = document.getElementById(containerId);
    if (!container) {
        alert(
            `Critical Error: Target container #${containerId} not found in DOM.`
        );
        return;
    }

    // Force visibility
    container.style.display = "block";
    container.style.minHeight = "400px";
    container.style.background = "#f9f9f9";

    // Clear and add debug header
    container.innerHTML = `
        <div style="padding:15px; background:#4caf50; color:white; margin-bottom:15px; border-radius:4px;">
            <strong>Gallery Renderer Working</strong><br>
            Products loaded: ${products ? products.length : 0}<br>
            Container: #${containerId}
        </div>
    `;

    if (!products || products.length === 0) {
        container.innerHTML +=
            '<div style="padding:20px; text-align:center; color:#666; background:white; border:1px solid #ddd;">No products found in this folder. Make sure you selected the correct download path.</div>';
        return;
    }

    // Limit for performance
    const limit = showAll ? products.length : 50;
    const productsToRender = products.slice(0, limit);

    if (products.length > limit) {
        const warning = document.createElement("div");
        warning.style.cssText =
            "padding:10px; background:#fff3cd; color:#856404; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;";
        warning.innerHTML = `
            <span>Showing first ${limit} of ${products.length} products for performance.</span>
            <button id="btnLoadAll-${containerId}" style="padding:5px 10px; font-size:12px; background:#856404; color:white; border:none; border-radius:4px; cursor:pointer;">Load All (${products.length})</button>
        `;
        container.appendChild(warning);

        // Use timeout to attach event after DOM insertion
        setTimeout(() => {
            const btn = document.getElementById(`btnLoadAll-${containerId}`);
            if (btn) {
                btn.onclick = () => renderGallery(products, containerId, true);
            }
        }, 0);
    } else if (showAll && products.length > 50) {
        container.innerHTML += `<div style="padding:10px; background:#d4edda; color:#155724; margin-bottom:10px;">Showing all ${products.length} products. This may affect performance.</div>`;
    }

    productsToRender.forEach((prod, idx) => {
        try {
            const row = document.createElement("div");
            row.style.cssText =
                "background:white; border:1px solid #e1e3e5; margin-bottom:15px; border-radius:8px; padding:15px;";

            // Header
            const header = document.createElement("div");
            header.style.cssText =
                "display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:10px;";

            // Build Meta Info
            let metaHtml = `<div style="font-size:1.1em; font-weight:bold;">${
                prod.title || prod.handle || "Unknown Product"
            }</div>`;

            if (prod.sku || prod.category) {
                metaHtml += `<div style="font-size:0.85em; color:#666; margin-top:4px;">`;
                if (prod.sku) metaHtml += `<span>SKU: ${prod.sku}</span>`;
                if (prod.category)
                    metaHtml += `<span style="margin-left:10px; background:#e1f5fe; color:#0277bd; padding:2px 6px; border-radius:4px; font-size:0.9em;">${prod.category}</span>`;
                metaHtml += `</div>`;
            }

            header.innerHTML = metaHtml;
            row.appendChild(header);

            // Media Grid
            const grid = document.createElement("div");
            grid.style.cssText =
                "display:flex; flex-direction:column; gap:15px;";
            const mainWrapper = grid; // Alias for internal logic

            if (prod.media && prod.media.length > 0) {
                // Group items
                const groups = { main: [], banner: [], extra: [], other: [] };

                prod.media.forEach((m) => {
                    let g = "other";
                    if (m.group) g = m.group;
                    else if (m.filename.startsWith("banner-")) g = "banner";
                    else if (m.filename.startsWith("extra-")) g = "extra";
                    else if (m.filename.startsWith("main-")) g = "main";

                    if (!groups[g]) groups[g] = []; // Safety
                    groups[g].push(m);
                });

                const renderSection = (title, items) => {
                    if (items.length === 0) return;

                    const sec = document.createElement("div");
                    sec.innerHTML = `<h5 style="margin:0 0 8px 0; color:#555; text-transform:uppercase; font-size:11px; letter-spacing:0.5px; border-bottom:1px solid #eee; padding-bottom:4px;">${title}</h5>`;

                    const rowDiv = document.createElement("div");
                    rowDiv.style.cssText =
                        "display:flex; flex-wrap:wrap; gap:10px;";

                    items.forEach((m) => {
                        const card = document.createElement("div");
                        card.style.cssText =
                            "width:100px; height:100px; border:1px solid #ddd; border-radius:4px; overflow:hidden; position:relative; background:#f0f0f0;";

                        if (m.status && m.status !== "unchanged") {
                            const badge = document.createElement("div");
                            badge.style.cssText =
                                "position:absolute; top:0; right:0; background:#2196f3; color:white; font-size:9px; padding:2px 4px; z-index:2;";
                            badge.textContent = m.status.toUpperCase();
                            card.appendChild(badge);
                        }

                        const img = document.createElement("img");
                        let filePath = m.src.replace(/\\/g, "/");
                        if (!filePath.startsWith("/"))
                            filePath = "/" + filePath;
                        img.src = "file://" + filePath;
                        img.style.cssText =
                            "width:100%; height:100%; object-fit:contain; background:#fff;"; // CHANGED to contain
                        img.title = m.filename;
                        img.onerror = function () {
                            this.style.display = "none";
                            card.innerHTML +=
                                '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:10px;color:#999;">No Preview</div>';
                        };
                        card.appendChild(img);

                        const label = document.createElement("div");
                        label.style.cssText =
                            "position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.7); color:white; font-size:9px; padding:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center;";
                        label.textContent = m.filename;
                        card.appendChild(label);

                        rowDiv.appendChild(card);
                    });

                    sec.appendChild(rowDiv);
                    mainWrapper.appendChild(sec);
                };

                // Order: Main, Banner, Extra, Other
                renderSection("Main Images", groups.main);
                renderSection("Banners", groups.banner);
                renderSection("Extras", groups.extra);
                renderSection("Other", groups.other);

                // grid is populated by renderSection (which appends to mainWrapper which is grid)
            } else {
                grid.innerHTML =
                    '<div style="color:#999; padding:10px;">No media files in this product folder.</div>';
            }

            row.appendChild(grid);
            container.appendChild(row);
        } catch (err) {
            console.error(`Error rendering product ${idx}:`, err);
        }
    });

    console.log(
        `[renderGallery] Finished. Container now has ${container.children.length} children.`
    );
}

// Debounce Utility
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// Attach debounced search listener
const searchInput = document.getElementById("libSearch");
if (searchInput) {
    searchInput.addEventListener(
        "keyup",
        debounce(() => {
            filterLibrary();
        }, 400)
    );
}
