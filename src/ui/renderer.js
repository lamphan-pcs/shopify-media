const { ipcRenderer } = require("electron");
const path = require("path"); // Load path module at top level

// Media type filter state
let activeMediaType = localStorage.getItem("activeMediaType") || "all";

// Pending image reorders: { [handle]: { productId, moves: [{id, newPosition}] } }
let pendingReorders = {};
const _dnd = { srcEl: null };

let selectedPath = localStorage.getItem("lastPath") || "";
document.getElementById("pathDisplay").value = selectedPath;
document.getElementById("shopUrl").value =
    localStorage.getItem("lastShop") || "";
document.getElementById("apiKey").value = localStorage.getItem("lastKey") || "";
document.getElementById("metafields").value =
    localStorage.getItem("lastMetafields") || "";

// Restore shipping calculator inputs
document.getElementById("shipHandles").value =
    localStorage.getItem("shipHandles") || "";
document.getElementById("shipVariantIds").value =
    localStorage.getItem("shipVariantIds") || "";

// Restore 5 address rows — migrate legacy single-address keys if needed
(function restoreAddresses() {
    const saved = JSON.parse(localStorage.getItem("shipAddresses") || "null");
    if (saved) {
        saved.forEach((addr, i) => {
            const chk = document.getElementById(`addrCheck${i}`);
            if (chk) chk.checked = addr.checked !== false;
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = val || "";
            };
            set(`addrAddress1_${i}`, addr.address1);
            set(`addrCity_${i}`, addr.city);
            set(`addrProvince_${i}`, addr.province);
            set(`addrZip_${i}`, addr.zip);
            set(`addrCountry_${i}`, addr.countryCode);
        });
    } else {
        // Migrate old single-address keys to row 0
        const old1 = localStorage.getItem("shipAddress1");
        if (old1) {
            document.getElementById("addrAddress1_0").value = old1;
            document.getElementById("addrCity_0").value =
                localStorage.getItem("shipCity") || "";
            document.getElementById("addrProvince_0").value =
                localStorage.getItem("shipProvince") || "";
            document.getElementById("addrZip_0").value =
                localStorage.getItem("shipZip") || "";
            document.getElementById("addrCountry_0").value =
                localStorage.getItem("shipCountryCode") || "";
        }
    }
})();

function toggleAllAddresses() {
    const checks = [0, 1, 2, 3, 4].map((i) =>
        document.getElementById(`addrCheck${i}`),
    );
    const allChecked = checks.every((c) => c && c.checked);
    checks.forEach((c) => {
        if (c) c.checked = !allChecked;
    });
    document.getElementById("selectAllAddressesBtn").textContent = allChecked
        ? "Select All"
        : "Deselect All";
}

// Restore input mode toggle
const _savedInputMode = localStorage.getItem("shipInputMode") || "handles";
setShippingInputMode(_savedInputMode);

function setShippingInputMode(mode) {
    const handlesArea = document.getElementById("shipHandles");
    const variantsArea = document.getElementById("shipVariantIds");
    const hint = document.getElementById("shipVariantIdsHint");
    const handlesBtn = document.getElementById("inputModeHandlesBtn");
    const variantsBtn = document.getElementById("inputModeVariantsBtn");

    if (mode === "variants") {
        handlesArea.style.display = "none";
        variantsArea.style.display = "block";
        hint.style.display = "block";
        handlesBtn.style.background = "#f1f2f3";
        handlesBtn.style.color = "#333";
        handlesBtn.style.borderColor = "#ccc";
        variantsBtn.style.background = "#008060";
        variantsBtn.style.color = "white";
        variantsBtn.style.borderColor = "#008060";
    } else {
        handlesArea.style.display = "block";
        variantsArea.style.display = "none";
        hint.style.display = "none";
        handlesBtn.style.background = "#008060";
        handlesBtn.style.color = "white";
        handlesBtn.style.borderColor = "#008060";
        variantsBtn.style.background = "#f1f2f3";
        variantsBtn.style.color = "#333";
        variantsBtn.style.borderColor = "#ccc";
    }
    localStorage.setItem("shipInputMode", mode);
}

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
            if (btn.innerText.toLowerCase().includes(tabName.toLowerCase())) {
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
                initMediaTypeButtons(); // Initialize button states
                loadLocalLibrary(true);
            }, 50);
        }
    } catch (e) {
        console.error("Error in switchTab:", e);
        alert("Error switching tab: " + e.message);
    }
}

let cachedLibrary = [];

async function loadLocalLibrary(
    renderToLibraryTab = false,
    cleanupBeforeScan = false,
) {
    console.log("Loading Local Library from:", selectedPath);
    if (!selectedPath) {
        if (renderToLibraryTab) {
            document.getElementById("fullLibraryArea").innerHTML =
                '<div style="padding:20px; text-align:center;">Please select a folder first.</div>';
        }
        return;
    }

    try {
        if (cleanupBeforeScan) {
            const cleanupResult = await ipcRenderer.invoke(
                "cleanup-unused-images",
                selectedPath,
            );

            if (renderToLibraryTab) {
                const removed = cleanupResult?.deleted || 0;
                const scanned = cleanupResult?.scanned || 0;
                const statusText =
                    removed > 0
                        ? `Rescan cleanup removed ${removed} unused file(s) from ${scanned} scanned.`
                        : `Rescan cleanup complete. No unused files found across ${scanned} scanned file(s).`;

                document.getElementById("fullLibraryArea").innerHTML =
                    `<div style="padding:12px; margin-bottom:12px; background:#e8f5e9; color:#1b5e20; border:1px solid #c8e6c9; border-radius:6px;">${statusText}</div>`;
            }
        }

        const products = await ipcRenderer.invoke("load-library", selectedPath);
        console.log("Loaded products:", products ? products.length : "null");
        cachedLibrary = products || [];

        if (renderToLibraryTab) {
            filterLibrary();
        }
    } catch (e) {
        console.error("Failed to load local library", e);
        if (renderToLibraryTab) {
            document.getElementById("fullLibraryArea").innerHTML =
                `<div style="color:red; padding:20px;">Error loading library: ${e.message}</div>`;
        }
    }
}

async function rescanLibrary() {
    await loadLocalLibrary(true, true);
}

async function cleanupLibrary() {
    if (!selectedPath) return alert("No folder selected.");

    if (
        !confirm(
            "Are you sure you want to clean up unused images?\n\nThis will permanently delete any image files in the current folder that are not referenced by the loaded product library. This cannot be undone.",
        )
    ) {
        return;
    }

    const btn = document.getElementById("cleanupBtn");
    const originalText = btn ? btn.innerText : "Clean Up";
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Cleaning...";
    }

    try {
        const result = await ipcRenderer.invoke(
            "cleanup-unused-images",
            selectedPath,
        );
        alert(
            `Cleanup Complete.\nScanned files: ${result.scanned}\nDeleted files: ${result.deleted}`,
        );
        // Refresh library to verify
        loadLocalLibrary(true);
    } catch (e) {
        console.error("Cleanup Error:", e);
        alert("Error during cleanup: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = originalText;
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

    // Sort: Products with updates first
    filtered.sort((a, b) => {
        const hasUpdate = (p) =>
            p.media &&
            p.media.some(
                (m) =>
                    m.status &&
                    m.status !== "unchanged" &&
                    m.status !== "local",
            );
        const aUp = hasUpdate(a);
        const bUp = hasUpdate(b);
        if (aUp === bUp) return 0;
        return aUp ? -1 : 1;
    });

    renderGallery(filtered, "fullLibraryArea");
}

function toggleMediaType(type) {
    activeMediaType = type;
    localStorage.setItem("activeMediaType", type);

    // Update button styles
    const buttons = {
        all: document.getElementById("mediaTypeAll"),
        main: document.getElementById("mediaTypeMain"),
        banner: document.getElementById("mediaTypeBanner"),
        extra: document.getElementById("mediaTypeExtra"),
    };

    // Reset all buttons to inactive state
    Object.values(buttons).forEach((btn) => {
        if (btn) {
            btn.style.background = "#f1f2f3";
            btn.style.color = "#333";
            btn.style.borderColor = "#ccc";
        }
    });

    // Set active button style
    if (buttons[type]) {
        buttons[type].style.background = "#008060";
        buttons[type].style.color = "white";
        buttons[type].style.borderColor = "#008060";
    }

    // Re-render the gallery with the new filter
    filterLibrary();
}

// Initialize media type button states on page load
function initMediaTypeButtons() {
    const buttons = {
        all: document.getElementById("mediaTypeAll"),
        main: document.getElementById("mediaTypeMain"),
        banner: document.getElementById("mediaTypeBanner"),
        extra: document.getElementById("mediaTypeExtra"),
    };

    // Reset all buttons
    Object.values(buttons).forEach((btn) => {
        if (btn) {
            btn.style.background = "#f1f2f3";
            btn.style.color = "#333";
            btn.style.borderColor = "#ccc";
        }
    });

    // Set active button based on saved state
    if (buttons[activeMediaType]) {
        buttons[activeMediaType].style.background = "#008060";
        buttons[activeMediaType].style.color = "white";
        buttons[activeMediaType].style.borderColor = "#008060";
    }
}

// Call initialization after DOM is loaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMediaTypeButtons);
} else {
    initMediaTypeButtons();
}

// --- Image Reorder Bar ---

function updateReorderBar() {
    const count = Object.keys(pendingReorders).length;
    const bar = document.getElementById("reorderBar");
    const msg = document.getElementById("reorderBarMsg");
    if (!bar) return;
    if (count === 0) {
        bar.style.display = "none";
    } else {
        bar.style.display = "flex";
        if (msg)
            msg.textContent = `${count} product${count !== 1 ? "s" : ""} with reordered images — push to apply on Shopify`;
    }
}

async function pushReordersToShopify() {
    const shopUrl = document.getElementById("shopUrl").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    if (!shopUrl || !apiKey) {
        return alert(
            "Please fill in Shop URL and API Token on the Sync Dashboard tab first.",
        );
    }
    const handles = Object.keys(pendingReorders);
    if (handles.length === 0) return;

    // Check if any productIds are missing and fetch them
    const missingHandles = handles.filter((h) => !pendingReorders[h].productId);
    if (missingHandles.length > 0) {
        const btn = document.getElementById("pushReordersBtn");
        if (btn) btn.textContent = `Fetching IDs…`;

        try {
            for (const h of missingHandles) {
                const id = await ipcRenderer.invoke("fetch-product-id", {
                    shopUrl,
                    apiKey,
                    handle: h,
                });
                if (id) {
                    pendingReorders[h].productId = id;
                }
            }
        } catch (err) {
            showCopyableError(
                "Error Fetching Product IDs",
                err.message || String(err),
            );
            if (btn) btn.textContent = "Push to Shopify";
            return;
        }
    }

    const reorders = handles.map((h) => ({
        handle: h,
        productId: pendingReorders[h].productId,
        moves: pendingReorders[h].moves,
    }));

    const btn = document.getElementById("pushReordersBtn");
    if (btn) {
        btn.disabled = true;
        btn.textContent = `Pushing ${handles.length}…`;
    }

    try {
        const results = await ipcRenderer.invoke("reorder-product-media", {
            shopUrl,
            apiKey,
            reorders,
        });
        const failed = results.filter((r) => !r.success);
        const succeeded = results.filter((r) => r.success);

        succeeded.forEach((r) => {
            delete pendingReorders[r.handle];
            const productRow = document.querySelector(
                `[data-product-handle="${r.handle}"]`,
            );
            if (productRow) {
                productRow.style.outline = "2px solid #4caf50";
                setTimeout(() => {
                    if (productRow) productRow.style.outline = "";
                }, 2500);
            }
        });

        if (failed.length > 0) {
            const errorText = `${succeeded.length} reorder(s) pushed.\n\n${failed.length} failed:\n${failed.map((r) => `• ${r.handle}: ${r.error}`).join("\n")}`;
            showCopyableError("Reorder Partially Failed", errorText);
        }
    } catch (err) {
        showCopyableError("Reorder Failed", err.message || String(err));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Push to Shopify";
        }
        updateReorderBar();
    }
}

function discardReorders() {
    pendingReorders = {};
    document.querySelectorAll("[data-product-handle]").forEach((el) => {
        el.style.outline = "";
    });
    updateReorderBar();
}

// --- Copyable Error Modal ---

function showCopyableError(title, message) {
    const modal = document.getElementById("errorModal");
    if (!modal) {
        // Create modal if it doesn't exist
        const div = document.createElement("div");
        div.id = "errorModal";
        div.style.cssText = `
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 10000;
            align-items: center;
            justify-content: center;
        `;
        div.innerHTML = `
            <div style="background: white; border-radius: 8px; padding: 20px; max-width: 600px; max-height: 70vh; display: flex; flex-direction: column; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <h2 id="errorModalTitle" style="margin-top: 0; color: #d32f2f;"></h2>
                <textarea id="errorModalText" style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 12px; overflow: auto; resize: none;"></textarea>
                <div style="display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;">
                    <button onclick="copyErrorMessage()" style="padding: 8px 16px; background: #2196f3; color: white; border: none; border-radius: 4px; cursor: pointer;">Copy</button>
                    <button onclick="closeErrorModal()" style="padding: 8px 16px; background: #f1f2f3; color: #333; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(div);
    }

    document.getElementById("errorModalTitle").textContent = title;
    document.getElementById("errorModalText").value = message;
    document.getElementById("errorModal").style.display = "flex";
}

function closeErrorModal() {
    const modal = document.getElementById("errorModal");
    if (modal) modal.style.display = "none";
}

function copyErrorMessage() {
    const textarea = document.getElementById("errorModalText");
    textarea.select();
    document.execCommand("copy");
    const btn = event.target;
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
        btn.textContent = original;
    }, 2000);
}

// Close modal on Escape key
document.addEventListener("keydown", (e) => {
    if (
        e.key === "Escape" &&
        document.getElementById("errorModal")?.style.display === "flex"
    ) {
        closeErrorModal();
    }
});

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
        const forceFullSyncInput = document.getElementById("forceFullSync");

        if (!shopUrlInput || !apiKeyInput || !metafieldsInput || !dryRunInput) {
            throw new Error(
                "Critical UI Error: One or more input fields are missing from the DOM.",
            );
        }

        const shopUrl = shopUrlInput.value;
        const apiKey = apiKeyInput.value;
        const metafields = metafieldsInput.value;
        const dryRun = dryRunInput.checked;
        const forceFullSync = forceFullSyncInput
            ? forceFullSyncInput.checked
            : false;

        console.log("Config loaded", { shopUrl, dryRun, forceFullSync });

        if (!shopUrl || !apiKey || !selectedPath) {
            return alert(
                "Please complete all configuration fields (Shop URL, API Key, and Folder).",
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
            forceFullSync,
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
                " ",
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
        } products for #${containerId}`,
    );

    const container = document.getElementById(containerId);
    if (!container) {
        alert(
            `Critical Error: Target container #${containerId} not found in DOM.`,
        );
        return;
    }

    // Force visibility
    container.style.display = "block";
    container.style.minHeight = "400px";
    container.style.background = "#f9f9f9";

    // Clear and add debug header
    let headerAction = "";
    if (containerId === "fullLibraryArea") {
        headerAction = `<div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.3);">
            <button id="cleanupBtn" onclick="cleanupLibrary()" style="padding:8px 15px; background:#d32f2f; color:white; border:none; border-radius:3px; cursor:pointer; font-weight:bold; font-size: 13px;">
                🗑 Clean Up Unused Images
            </button>
        </div>`;
    }

    container.innerHTML = `
        <div style="padding:15px; background:#4caf50; color:white; margin-bottom:15px; border-radius:4px;">
            <strong>Gallery Renderer Working</strong><br>
            Products loaded: ${products ? products.length : 0}<br>
            Container: #${containerId}
            ${headerAction}
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
            row.dataset.productHandle = prod.handle;

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

                const canDnd = true; // Allow drag-drop for all synced products; IDs fetched on push

                const renderSection = (title, items, isDraggable = false) => {
                    if (items.length === 0) return;

                    const sec = document.createElement("div");
                    const hint = isDraggable
                        ? ' <span style="font-size:10px;color:#aaa;font-weight:400;margin-left:4px;">drag to reorder</span>'
                        : "";
                    sec.innerHTML = `<h5 style="margin:0 0 8px 0; color:#555; text-transform:uppercase; font-size:11px; letter-spacing:0.5px; border-bottom:1px solid #eee; padding-bottom:4px;">${title}${hint}</h5>`;

                    const rowDiv = document.createElement("div");
                    rowDiv.style.cssText =
                        "display:flex; flex-wrap:wrap; gap:10px;";

                    if (isDraggable && canDnd) {
                        rowDiv.dataset.dndHandle = prod.handle;
                        rowDiv.dataset.dndProductId = prod.shopifyId || ""; // Can be empty; fetched on push

                        rowDiv.addEventListener("dragover", (e) => {
                            e.preventDefault();
                            const target =
                                e.target.closest &&
                                e.target.closest(".dnd-card");
                            if (target && target !== _dnd.srcEl) {
                                rowDiv
                                    .querySelectorAll(".dnd-card")
                                    .forEach((c) => {
                                        c.style.outline = "";
                                    });
                                target.style.outline = "2px dashed #008060";
                            }
                        });

                        rowDiv.addEventListener("dragleave", (e) => {
                            if (!rowDiv.contains(e.relatedTarget)) {
                                rowDiv
                                    .querySelectorAll(".dnd-card")
                                    .forEach((c) => {
                                        c.style.outline = "";
                                    });
                            }
                        });

                        rowDiv.addEventListener("drop", (e) => {
                            e.preventDefault();
                            rowDiv
                                .querySelectorAll(".dnd-card")
                                .forEach((c) => {
                                    c.style.outline = "";
                                });
                            const dst =
                                e.target.closest &&
                                e.target.closest(".dnd-card");
                            if (
                                !dst ||
                                !_dnd.srcEl ||
                                dst === _dnd.srcEl ||
                                !rowDiv.contains(dst)
                            )
                                return;

                            const srcIdx = [...rowDiv.children].indexOf(
                                _dnd.srcEl,
                            );
                            const dstIdx = [...rowDiv.children].indexOf(dst);
                            if (srcIdx < dstIdx)
                                rowDiv.insertBefore(
                                    _dnd.srcEl,
                                    dst.nextSibling,
                                );
                            else rowDiv.insertBefore(_dnd.srcEl, dst);

                            const handle = rowDiv.dataset.dndHandle;
                            const productId = rowDiv.dataset.dndProductId;
                            const moves = [
                                ...rowDiv.querySelectorAll(".dnd-card"),
                            ].map((c, i) => ({
                                id: c.dataset.dndMediaId,
                                newPosition: i,
                            }));

                            if (moves.length >= 2) {
                                pendingReorders[handle] = { productId, moves };
                                const productRow = document.querySelector(
                                    `[data-product-handle="${handle}"]`,
                                );
                                if (productRow)
                                    productRow.style.outline =
                                        "2px solid #ff9800";
                                updateReorderBar();
                            }
                        });
                    }

                    items.forEach((m) => {
                        const card = document.createElement("div");
                        card.style.cssText =
                            "width:100px; height:100px; border:1px solid #ddd; border-radius:4px; overflow:hidden; position:relative; background:#f0f0f0;";

                        const hasSyncId =
                            isDraggable && canDnd && !!m.shopifyId;
                        if (isDraggable && canDnd) {
                            card.draggable = true;
                            card.dataset.dndMediaId = m.shopifyId || m.filename; // Use filename as fallback key
                            card.style.cursor = "grab";
                            card.classList.add("dnd-card");
                            card.addEventListener("dragstart", (e) => {
                                _dnd.srcEl = card;
                                e.dataTransfer.effectAllowed = "move";
                                setTimeout(() => {
                                    card.style.opacity = "0.4";
                                }, 0);
                            });
                            card.addEventListener("dragend", () => {
                                card.style.opacity = "1";
                                _dnd.srcEl = null;
                            });
                        }

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
                            "width:100%; height:100%; object-fit:contain; background:#fff; pointer-events:none;";
                        img.title = m.filename;
                        img.onerror = function () {
                            this.style.display = "none";
                            card.innerHTML +=
                                '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:10px;color:#999;">No Preview</div>';
                        };
                        card.appendChild(img);

                        const label = document.createElement("div");
                        label.style.cssText =
                            "position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.7); color:white; font-size:9px; padding:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center; pointer-events:none;";
                        label.textContent = m.filename;
                        card.appendChild(label);

                        rowDiv.appendChild(card);
                    });

                    sec.appendChild(rowDiv);
                    mainWrapper.appendChild(sec);
                };

                // Sort main images by manifest position for correct initial order
                groups.main.sort(
                    (a, b) => (a.position || 0) - (b.position || 0),
                );

                // Order: Main, Banner, Extra, Other
                // Filter based on activeMediaType
                if (activeMediaType === "all") {
                    renderSection("Main Images", groups.main, true);
                    renderSection("Banners", groups.banner);
                    renderSection("Extras", groups.extra);
                    renderSection("Other", groups.other);
                } else if (activeMediaType === "main") {
                    renderSection("Main Images", groups.main, true);
                } else if (activeMediaType === "banner") {
                    renderSection("Banners", groups.banner);
                } else if (activeMediaType === "extra") {
                    renderSection("Extras", groups.extra);
                }

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
        `[renderGallery] Finished. Container now has ${container.children.length} children.`,
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
        }, 400),
    );
}

let _shippingRows = [];
let _shippingCarriers = [];
let _shippingHasVariants = false;

async function calculateShipping() {
    const inputMode = localStorage.getItem("shipInputMode") || "handles";
    const handlesRaw = document.getElementById("shipHandles").value;
    const variantIdsRaw = document.getElementById("shipVariantIds").value;

    // Collect checked addresses
    const addresses = [];
    for (let i = 0; i < 5; i++) {
        const chk = document.getElementById(`addrCheck${i}`);
        if (!chk || !chk.checked) continue;
        const address1 = document
            .getElementById(`addrAddress1_${i}`)
            .value.trim();
        const city = document.getElementById(`addrCity_${i}`).value.trim();
        const province = document
            .getElementById(`addrProvince_${i}`)
            .value.trim();
        const zip = document.getElementById(`addrZip_${i}`).value.trim();
        const countryCode = document
            .getElementById(`addrCountry_${i}`)
            .value.trim()
            .toUpperCase();
        if (!address1 || !city || !zip || !countryCode) {
            return alert(
                `Address ${i + 1} is incomplete. Fill in Address Line 1, City, ZIP, and Country Code.`,
            );
        }
        addresses.push({ address1, city, province, zip, countryCode });
    }

    if (addresses.length === 0) {
        return alert("Please check and fill at least one address.");
    }

    // Persist addresses
    const addressData = Array.from({ length: 5 }, (_, i) => ({
        checked: document.getElementById(`addrCheck${i}`)?.checked || false,
        address1: document.getElementById(`addrAddress1_${i}`)?.value || "",
        city: document.getElementById(`addrCity_${i}`)?.value || "",
        province: document.getElementById(`addrProvince_${i}`)?.value || "",
        zip: document.getElementById(`addrZip_${i}`)?.value || "",
        countryCode: document.getElementById(`addrCountry_${i}`)?.value || "",
    }));
    localStorage.setItem("shipAddresses", JSON.stringify(addressData));
    localStorage.setItem("shipHandles", handlesRaw);
    localStorage.setItem("shipVariantIds", variantIdsRaw);

    const handles = handlesRaw
        .split("\n")
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
    const variantIds = variantIdsRaw
        .split("\n")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

    if (inputMode === "variants" && variantIds.length === 0)
        return alert("Please enter at least one variant ID.");
    if (inputMode !== "variants" && handles.length === 0)
        return alert("Please enter at least one product handle.");

    const shopUrl = document.getElementById("shopUrl").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    if (!shopUrl || !apiKey)
        return alert(
            "Please fill in Shop URL and API Token on the Sync Dashboard tab first.",
        );

    // Reset
    _shippingRows = [];
    _shippingCarriers = [];
    _shippingHasVariants = false;

    const btn = document.getElementById("shippingBtn");
    btn.disabled = true;
    btn.innerText = "CALCULATING...";
    const copyBtn = document.getElementById("copyTableBtn");
    const copyCustomBtn = document.getElementById("copyCustomFormatBtn");
    if (copyBtn) copyBtn.style.display = "none";
    if (copyCustomBtn) copyCustomBtn.style.display = "none";

    document.getElementById("shippingLoading").style.display = "block";
    document.getElementById("shippingErrorArea").style.display = "none";
    document.getElementById("shippingResultsArea").style.display = "block";
    renderShippingTable({ rows: [], carriers: [], hasVariants: false });

    const itemCount =
        inputMode === "variants" ? variantIds.length : handles.length;
    const progressMsg = document.getElementById("shippingProgressMsg");

    try {
        for (let ai = 0; ai < addresses.length; ai++) {
            const addr = addresses[ai];
            if (progressMsg)
                progressMsg.textContent = `[${addr.city} — address ${ai + 1}/${addresses.length}] Starting — 0 / ${itemCount}`;
            await ipcRenderer.invoke("calculate-shipping", {
                shopUrl,
                apiKey,
                handles: inputMode !== "variants" ? handles : [],
                variantIds: inputMode === "variants" ? variantIds : [],
                address: addr,
            });
        }
    } catch (err) {
        console.error("Shipping Calculation Error:", err);
        const errDiv = document.getElementById("shippingErrorArea");
        const errMsg = document.getElementById("shippingErrorMsg");
        errDiv.style.display = "block";
        errMsg.innerText = err.stack || err.message;
    } finally {
        btn.disabled = false;
        btn.innerText = "CALCULATE SHIPPING";
        document.getElementById("shippingLoading").style.display = "none";
        if (progressMsg) progressMsg.textContent = "";
        if (_shippingRows.length > 0 && copyBtn)
            copyBtn.style.display = "inline-block";
        if (_shippingRows.length > 0 && copyCustomBtn)
            copyCustomBtn.style.display = "inline-block";
    }
}

function pasteShippingOutput() {
    const modal = document.getElementById("pasteOutputModal");
    document.getElementById("pasteOutputTextarea").value = "";
    modal.style.display = "flex";
    setTimeout(
        () => document.getElementById("pasteOutputTextarea").focus(),
        50,
    );
}

function closePasteModal() {
    document.getElementById("pasteOutputModal").style.display = "none";
}

function importPastedOutput() {
    const tsv = document.getElementById("pasteOutputTextarea").value.trim();
    if (!tsv) return alert("Nothing pasted.");

    const lines = tsv.split("\n").map((l) => l.trimEnd());
    if (lines.length < 2)
        return alert(
            "Pasted data needs at least a header row and one data row.",
        );

    const headers = lines[0].split("\t").map((h) => h.trim());
    if (headers.length < 3)
        return alert(
            "Unrecognised format. Make sure you copied from the Shipping Rates table.",
        );

    const hasVariants = headers.includes("Variant");
    const fixedCols = hasVariants
        ? ["Handle", "Product Title", "Variant", "SKU", "Weight"]
        : ["Handle", "Product Title", "SKU", "Weight"];
    const cityColIdx = headers.length - 1;
    const carriers = headers.slice(fixedCols.length, cityColIdx);

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = lines[i].split("\t");
        const row = {
            handle: cols[0] || "",
            title: cols[1] || "",
            rates: {},
            addressCity: cols[cityColIdx] || "",
        };
        if (hasVariants) {
            row.variant = cols[2] || "";
            row.sku = cols[3] || "";
            row.weight = cols[4] || "";
        } else {
            row.sku = cols[2] || "";
            row.weight = cols[3] || "";
        }
        carriers.forEach((carrier, ci) => {
            const val = (cols[fixedCols.length + ci] || "").trim();
            if (val && val !== "N/A") row.rates[carrier] = val;
        });
        rows.push(row);
    }

    if (rows.length === 0)
        return alert("No data rows found in pasted content.");

    _shippingRows = rows;
    _shippingCarriers = carriers;
    _shippingHasVariants = hasVariants;

    closePasteModal();
    renderShippingTable({ rows, carriers, hasVariants });

    const copyBtn = document.getElementById("copyTableBtn");
    if (copyBtn) copyBtn.style.display = "inline-block";
    const copyCustomBtn = document.getElementById("copyCustomFormatBtn");
    if (copyCustomBtn) copyCustomBtn.style.display = "inline-block";
}

function copyShippingCustomFormat() {
    if (!_shippingRows.length) return;

    const carriers = _shippingCarriers;
    const hasVariants = _shippingHasVariants;

    // Collect unique cities in order of first appearance
    const cities = [];
    const citySet = new Set();
    _shippingRows.forEach((r) => {
        if (r.addressCity && !citySet.has(r.addressCity)) {
            citySet.add(r.addressCity);
            cities.push(r.addressCity);
        }
    });

    // Collect unique products (handle + variant) in order of first appearance
    const productKeys = [];
    const productKeySet = new Set();
    const productMap = {};
    _shippingRows.forEach((r) => {
        const key = r.handle + "\x00" + (r.variant || "");
        if (!productKeySet.has(key)) {
            productKeySet.add(key);
            productKeys.push(key);
            productMap[key] = {
                handle: r.handle,
                title: r.title,
                variant: r.variant || "",
                sku: r.sku || "",
                weight: r.weight || "",
                ratesByCarrierCity: {},
            };
        }
        carriers.forEach((carrier) => {
            const rateKey = carrier + "\x00" + r.addressCity;
            productMap[key].ratesByCarrierCity[rateKey] =
                r.rates[carrier] || "";
        });
    });

    const fixedCols = hasVariants
        ? ["Handle", "Product Title", "Variant", "SKU", "Weight"]
        : ["Handle", "Product Title", "SKU", "Weight"];
    const numFixed = fixedCols.length;

    const tsvLines = [];

    // Row 1: carrier name in the first column of its group, blanks for the rest
    const row1 = Array(numFixed).fill("");
    carriers.forEach((carrier) => {
        row1.push(carrier);
        for (let c = 1; c < cities.length; c++) row1.push("");
    });
    tsvLines.push(row1.join("\t"));

    // Row 2: fixed headers then cities repeated per carrier
    const row2 = [...fixedCols];
    carriers.forEach(() => cities.forEach((city) => row2.push(city)));
    tsvLines.push(row2.join("\t"));

    // Data rows: one row per unique product
    productKeys.forEach((key) => {
        const p = productMap[key];
        const dataRow = hasVariants
            ? [p.handle, p.title, p.variant, p.sku, p.weight]
            : [p.handle, p.title, p.sku, p.weight];
        carriers.forEach((carrier) => {
            cities.forEach((city) => {
                const rate = p.ratesByCarrierCity[carrier + "\x00" + city];
                dataRow.push(rate || "N/A");
            });
        });
        tsvLines.push(dataRow.join("\t"));
    });

    navigator.clipboard.writeText(tsvLines.join("\n")).then(() => {
        const btn = document.getElementById("copyCustomFormatBtn");
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
            btn.textContent = orig;
        }, 2000);
    });
}

function copyShippingTable() {
    const table = document.getElementById("shippingTable");
    const tsv = Array.from(table.querySelectorAll("tr"))
        .map((tr) =>
            Array.from(tr.querySelectorAll("th, td"))
                .map((cell) => cell.textContent.trim())
                .join("\t"),
        )
        .join("\n");
    navigator.clipboard.writeText(tsv).then(() => {
        const btn = document.getElementById("copyTableBtn");
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
            btn.textContent = orig;
        }, 2000);
    });
}

function renderShippingTable(result) {
    const { rows, carriers, hasVariants } = result;

    const table = document.getElementById("shippingTable");
    table.innerHTML = "";

    const fixedCols = hasVariants
        ? ["Handle", "Product Title", "Variant", "SKU", "Weight"]
        : ["Handle", "Product Title", "SKU", "Weight"];
    const allCols = [...fixedCols, ...carriers, "City"];

    // Header row
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    allCols.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement("tbody");

    if (rows.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = allCols.length;
        td.style.textAlign = "center";
        td.style.padding = "20px";
        td.textContent = "No results.";
        tr.appendChild(td);
        tbody.appendChild(tr);
    } else {
        let lastCity = null;
        rows.forEach((row) => {
            const tr = document.createElement("tr");

            const handleTd = document.createElement("td");
            handleTd.textContent = row.handle;
            handleTd.style.fontFamily = "Consolas, monospace";
            handleTd.style.fontSize = "0.9em";
            tr.appendChild(handleTd);

            if (row.error) {
                const titleTd = document.createElement("td");
                titleTd.textContent = row.title || "—";
                tr.appendChild(titleTd);

                const errorTd = document.createElement("td");
                errorTd.colSpan = allCols.length - 2; // -2 for Handle + City
                errorTd.style.color = "#b71c1c";
                errorTd.style.fontStyle = "italic";
                errorTd.textContent = row.error;
                tr.appendChild(errorTd);
            } else {
                const titleTd = document.createElement("td");
                titleTd.textContent = row.title;
                tr.appendChild(titleTd);

                if (hasVariants) {
                    const variantTd = document.createElement("td");
                    variantTd.textContent = row.variant || "—";
                    variantTd.style.fontSize = "0.85em";
                    variantTd.style.color = "#555";
                    tr.appendChild(variantTd);
                }

                const skuTd = document.createElement("td");
                skuTd.textContent = row.sku || "—";
                skuTd.style.fontSize = "0.85em";
                skuTd.style.color = "#555";
                tr.appendChild(skuTd);

                const weightTd = document.createElement("td");
                weightTd.textContent = row.weight || "—";
                weightTd.style.fontSize = "0.85em";
                weightTd.style.color = "#555";
                tr.appendChild(weightTd);

                carriers.forEach((carrier) => {
                    const td = document.createElement("td");
                    const rate = row.rates[carrier];
                    if (rate) {
                        td.textContent = rate;
                        td.style.fontWeight = "600";
                        td.style.color = "#006840";
                    } else {
                        td.textContent = "N/A";
                        td.style.color = "#999";
                    }
                    tr.appendChild(td);
                });
            }

            // City — last column
            const cityTd = document.createElement("td");
            cityTd.textContent = row.addressCity || "";
            cityTd.style.fontWeight = "600";
            cityTd.style.color =
                row.addressCity !== lastCity ? "#008060" : "#bbb";
            cityTd.style.whiteSpace = "nowrap";
            if (row.addressCity !== lastCity) lastCity = row.addressCity;
            tr.appendChild(cityTd);

            tbody.appendChild(tr);
        });
    }

    table.appendChild(tbody);
    document.getElementById("shippingResultsArea").style.display = "block";
}

ipcRenderer.on("shipping-progress", (event, data) => {
    const progressMsg = document.getElementById("shippingProgressMsg");

    if (data.type === "catalog") {
        if (progressMsg) progressMsg.textContent = data.message;
    } else if (data.type === "lookup") {
        if (progressMsg)
            progressMsg.textContent = `[${data.current}/${data.total}] Looking up: ${data.handle}`;
    } else if (data.type === "calculating") {
        const variantPart = data.variantLabel ? ` / ${data.variantLabel}` : "";
        if (progressMsg)
            progressMsg.textContent = `[${data.current}/${data.total}] Fetching rates: ${data.title}${variantPart}`;
    } else if (data.type === "row-done") {
        _shippingRows.push(data.row);
        _shippingCarriers = data.carriers;
        if (data.hasVariants) _shippingHasVariants = true;
        renderShippingTable({
            rows: _shippingRows,
            carriers: _shippingCarriers,
            hasVariants: _shippingHasVariants,
        });
        const variantPart = data.row.variant ? ` / ${data.row.variant}` : "";
        const label = data.row.error
            ? `${data.row.handle}${variantPart} — ${data.row.error}`
            : `${data.row.title || data.row.handle}${variantPart} — ${Object.keys(data.row.rates).length} carrier(s)`;
        if (progressMsg)
            progressMsg.textContent = `[${data.current}/${data.total} done] ${label}`;
    } else if (data.type === "complete") {
        _shippingCarriers = data.carriers;
        if (data.hasVariants) _shippingHasVariants = true;
        renderShippingTable({
            rows: _shippingRows,
            carriers: _shippingCarriers,
            hasVariants: _shippingHasVariants,
        });
        if (progressMsg) progressMsg.textContent = "";
    }
});
