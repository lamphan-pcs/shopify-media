const { ipcRenderer } = require("electron");
const path = require("path"); // Load path module at top level

// Media type filter state
let activeMediaType = localStorage.getItem("activeMediaType") || "all";

// Pending image reorders: { [handle]: { productId, moves: [{id, newPosition}] } }
let pendingReorders = {};
let pendingRemovals = {};
let deleteMode = false;
const _dnd = { srcEl: null, srcHandle: null };

// ── Touch-to-DnD bridge ──────────────────────────────────────────────────────
// Converts touchstart/touchmove/touchend into synthetic drag events.
// Fires events on the EXACT element under the finger so that the drop handler's
// e.target.closest(".dnd-card") resolves correctly.
(function installTouchDnd() {
    let _touchSrc = null;
    let _touchClone = null;
    let _cloneW = 0;
    let _cloneH = 0;

    const elAt = (touch, hideEl) => {
        if (hideEl) hideEl.style.visibility = "hidden";
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        if (hideEl) hideEl.style.visibility = "";
        return el;
    };

    const fireDrag = (type, target, touch) => {
        const init = { bubbles: true, cancelable: true };
        if (touch) {
            init.clientX = touch.clientX;
            init.clientY = touch.clientY;
        }
        try {
            target.dispatchEvent(new DragEvent(type, init));
        } catch (_) {
            target.dispatchEvent(
                new Event(type, { bubbles: true, cancelable: true }),
            );
        }
    };

    document.addEventListener(
        "touchstart",
        (e) => {
            const card = e.target.closest && e.target.closest(".dnd-card");
            if (!card || !card.draggable) return;

            // In delete mode, let the tap fall through as a normal click — no drag.
            if (deleteMode) return;

            // Also check non-dnd-card removable cards
            const mediaCard =
                e.target.closest && e.target.closest(".media-card");
            if (
                mediaCard &&
                !mediaCard.classList.contains("dnd-card") &&
                deleteMode
            )
                return;

            _touchSrc = card;
            const rect = card.getBoundingClientRect();
            _cloneW = rect.width;
            _cloneH = rect.height;
            _touchClone = card.cloneNode(true);
            _touchClone.style.cssText = [
                "position:fixed",
                "pointer-events:none",
                "z-index:9999",
                "opacity:0.72",
                `width:${_cloneW}px`,
                `height:${_cloneH}px`,
                `left:${rect.left}px`,
                `top:${rect.top}px`,
                "border:2px dashed #008060",
                "border-radius:4px",
                "transition:none",
                "visibility:visible",
            ].join(";");
            document.body.appendChild(_touchClone);
            fireDrag("dragstart", card, e.touches[0]);
            e.preventDefault();
        },
        { passive: false },
    );

    document.addEventListener(
        "touchmove",
        (e) => {
            if (!_touchSrc) return;
            e.preventDefault();
            const touch = e.touches[0];

            // Move ghost
            _touchClone.style.left = `${touch.clientX - _cloneW / 2}px`;
            _touchClone.style.top = `${touch.clientY - _cloneH / 2}px`;

            // Find element under finger — prefer a .dnd-card, fall back to rowDiv
            const under = elAt(touch, _touchClone);
            const cardUnder =
                under && under.closest && under.closest(".dnd-card");
            const rowUnder =
                under && under.closest && under.closest("[data-dnd-group]");
            const fireTarget = cardUnder || rowUnder;
            if (fireTarget) fireDrag("dragover", fireTarget, touch);
        },
        { passive: false },
    );

    document.addEventListener("touchend", (e) => {
        if (!_touchSrc) return;
        const touch = e.changedTouches[0];
        const src = _touchSrc;

        // Remove ghost before hit-testing
        if (_touchClone) {
            document.body.removeChild(_touchClone);
            _touchClone = null;
        }

        const under = elAt(touch);
        const cardUnder = under && under.closest && under.closest(".dnd-card");
        const rowUnder =
            under && under.closest && under.closest("[data-dnd-group]");

        // Fire drop on the most precise target — card bubbles up to rowDiv
        const dropTarget = cardUnder || rowUnder;
        if (dropTarget) fireDrag("drop", dropTarget, touch);
        fireDrag("dragend", src, touch);

        _touchSrc = null;
    });

    document.addEventListener("touchcancel", () => {
        if (_touchClone) {
            document.body.removeChild(_touchClone);
            _touchClone = null;
        }
        if (_touchSrc) {
            fireDrag("dragend", _touchSrc, null);
            _touchSrc = null;
        }
    });
})();
// ────────────────────────────────────────────────────────────────────────────

let selectedPath = localStorage.getItem("lastPath") || "";

// Set up export progress listener - only once
ipcRenderer.on("export-progress", (event, progress) => {
    const progressArea = document.getElementById("progressArea");
    const progFill = document.getElementById("progFill");
    const statusText = document.getElementById("statusText");

    if (!progressArea || !progFill || !statusText) return;

    progressArea.style.display = "block";

    if (progress.status === "generating") {
        statusText.innerText = `✓ Downloaded ${progress.totalProducts} products. Generating CSV...`;
        progFill.style.width = "95%";
    } else {
        const percentage = progress.hasMore
            ? Math.min(
                  90,
                  Math.round(
                      (progress.totalProducts /
                          (progress.totalProducts * 1.1)) *
                          100,
                  ),
              )
            : 100;
        progFill.style.width = percentage + "%";
        statusText.innerText = `Fetching page ${progress.page}... (${progress.totalProducts} products downloaded)`;
    }
});

// Wait for DOM to be ready before accessing elements
document.addEventListener("DOMContentLoaded", () => {
    // Restore shop settings
    const pathDisplay = document.getElementById("pathDisplay");
    const shopUrl = document.getElementById("shopUrl");
    const apiKey = document.getElementById("apiKey");
    const metafields = document.getElementById("metafields");
    const shipHandles = document.getElementById("shipHandles");
    const shipVariantIds = document.getElementById("shipVariantIds");

    if (pathDisplay) pathDisplay.value = selectedPath;
    if (shopUrl) shopUrl.value = localStorage.getItem("lastShop") || "";
    if (apiKey) apiKey.value = localStorage.getItem("lastKey") || "";
    if (metafields)
        metafields.value = localStorage.getItem("lastMetafields") || "";
    if (shipHandles)
        shipHandles.value = localStorage.getItem("shipHandles") || "";
    if (shipVariantIds)
        shipVariantIds.value = localStorage.getItem("shipVariantIds") || "";

    // Restore 5 address rows — migrate legacy single-address keys if needed
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
            const el1 = document.getElementById("addrAddress1_0");
            const el2 = document.getElementById("addrCity_0");
            const el3 = document.getElementById("addrProvince_0");
            const el4 = document.getElementById("addrZip_0");
            const el5 = document.getElementById("addrCountry_0");
            if (el1) el1.value = old1;
            if (el2) el2.value = localStorage.getItem("shipCity") || "";
            if (el3) el3.value = localStorage.getItem("shipProvince") || "";
            if (el4) el4.value = localStorage.getItem("shipZip") || "";
            if (el5) el5.value = localStorage.getItem("shipCountryCode") || "";
        }
    }

    // Restore input mode toggle
    const _savedInputMode = localStorage.getItem("shipInputMode") || "handles";
    setShippingInputMode(_savedInputMode);
});

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
        // Show/hide floating panel
        const floatingPanel = document.getElementById("floatingLibraryPanel");
        if (floatingPanel) {
            floatingPanel.classList.toggle("visible", tabName === "library");
        }

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
        // User cancelled - restore focus
        setTimeout(() => {
            window.focus();
            const searchInput = document.getElementById("libSearch");
            if (searchInput) searchInput.focus();
        }, 50);
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

        // Restore focus to window and search input after alert closes
        // Use setTimeout to ensure dialog is fully closed and focus is returned to OS
        setTimeout(() => {
            // Force window focus first
            window.focus();
            // Then focus the search input
            const searchInput = document.getElementById("libSearch");
            if (searchInput) {
                searchInput.focus();
                // Also select any existing text for convenience
                searchInput.select();
            }
        }, 50);
    } catch (e) {
        console.error("Cleanup Error:", e);
        alert("Error during cleanup: " + e.message);
        // Restore focus after error alert too
        setTimeout(() => {
            window.focus();
            const searchInput = document.getElementById("libSearch");
            if (searchInput) {
                searchInput.focus();
            }
        }, 50);
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
            (p.productName && p.productName.toLowerCase().includes(query)) ||
            (p.folderName && p.folderName.toLowerCase().includes(query)) ||
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

    // Update button styles using classList instead of inline styles
    const buttons = {
        all: document.getElementById("mediaTypeAll"),
        main: document.getElementById("mediaTypeMain"),
        banner: document.getElementById("mediaTypeBanner"),
        extra: document.getElementById("mediaTypeExtra"),
    };

    // Remove active class from all buttons
    Object.values(buttons).forEach((btn) => {
        if (btn) {
            btn.classList.remove("active");
        }
    });

    // Add active class to the selected button
    if (buttons[type]) {
        buttons[type].classList.add("active");
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

    // Remove active class from all buttons
    Object.values(buttons).forEach((btn) => {
        if (btn) {
            btn.classList.remove("active");
        }
    });

    // Add active class to the saved button state
    if (buttons[activeMediaType]) {
        buttons[activeMediaType].classList.add("active");
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
        if (msg) {
            const handles = Object.keys(pendingReorders);
            const preview = handles.slice(0, 4).join(", ");
            const extra =
                handles.length > 4 ? ` +${handles.length - 4} more` : "";
            msg.textContent = `${count} product${count !== 1 ? "s" : ""} to be changed: ${preview}${extra}`;
        }
    }
    updateDeleteModeButton();
    // Sync floating push button
    const floatBtn = document.getElementById("floatPushBtn");
    if (floatBtn) {
        const hasRemovals = Object.keys(pendingRemovals).length > 0;
        if (!hasRemovals) {
            if (count > 0) {
                floatBtn.disabled = false;
                floatBtn.textContent = `↑ Push (${count})`;
            } else {
                floatBtn.disabled = true;
                floatBtn.textContent = "↑ Push to Shopify";
            }
        }
    }
}

function getMediaLayoutKey(media) {
    return (
        media.shopifyFileId || media.shopifyId || media.src || media.filename
    );
}

function normalizeLayout(layout) {
    const normalized = {
        main: [...(layout.main || [])],
        banner: [...(layout.banner || [])],
        extra: [...(layout.extra || [])],
        other: [...(layout.other || [])],
    };

    if (normalized.banner.length > 1) {
        const overflow = normalized.banner.slice(1);
        normalized.banner = normalized.banner.slice(0, 1);
        normalized.extra = [...overflow, ...normalized.extra];
    }

    return normalized;
}

function buildOriginalLayout(prod) {
    const groups = { main: [], banner: [], extra: [], other: [] };
    const sourceMedia = Array.isArray(prod.media) ? [...prod.media] : [];

    sourceMedia.sort((a, b) => {
        if ((a.group || "") === "main" && (b.group || "") === "main") {
            return (a.position || 0) - (b.position || 0);
        }
        return 0;
    });

    sourceMedia.forEach((media) => {
        let group = media.group || "other";
        if (!groups[group]) group = "other";
        groups[group].push(getMediaLayoutKey(media));
    });

    return normalizeLayout(groups);
}

function getLayoutItemMap(prod) {
    const map = new Map();
    (prod.media || []).forEach((media) => {
        map.set(getMediaLayoutKey(media), media);
    });
    return map;
}

function getDisplayLayout(prod) {
    const itemMap = getLayoutItemMap(prod);
    const storedLayout = pendingReorders[prod.handle]?.layout;
    const layout = storedLayout || buildOriginalLayout(prod);
    const display = { main: [], banner: [], extra: [], other: [] };
    const used = new Set();

    ["main", "banner", "extra", "other"].forEach((group) => {
        (layout[group] || []).forEach((key) => {
            const item = itemMap.get(key);
            // Guard: a key that already appeared in an earlier group is not duplicated
            if (item && !used.has(key)) {
                display[group].push(item);
                used.add(key);
            }
        });
    });

    (prod.media || []).forEach((media) => {
        const key = getMediaLayoutKey(media);
        if (!used.has(key)) {
            const group =
                media.group && display[media.group] ? media.group : "other";
            display[group].push(media);
            used.add(key);
        }
    });

    return display;
}

function layoutsEqual(left, right) {
    const groups = ["main", "banner", "extra", "other"];
    return groups.every((group) => {
        const leftItems = left[group] || [];
        const rightItems = right[group] || [];
        return (
            leftItems.length === rightItems.length &&
            leftItems.every((item, index) => item === rightItems[index])
        );
    });
}

function buildLayoutPayload(prod, layout) {
    const itemMap = getLayoutItemMap(prod);
    const toPayload = (key) => {
        const item = itemMap.get(key);
        if (!item) return null;
        const fileId = item.shopifyId || item.shopifyFileId || "";
        return {
            key,
            fileId,
            mediaId: item.shopifyId || fileId,
            filename: item.filename || "",
            type: item.type || "image",
        };
    };

    return {
        main: (layout.main || []).map(toPayload).filter(Boolean),
        banner: (layout.banner || []).map(toPayload).filter(Boolean),
        extra: (layout.extra || []).map(toPayload).filter(Boolean),
    };
}

function applyPendingLayoutToCachedProduct(handle, layout) {
    const product = cachedLibrary.find((item) => item.handle === handle);
    if (!product || !Array.isArray(product.media)) return;

    const itemMap = getLayoutItemMap(product);
    const groupAssignments = {};

    ["main", "banner", "extra", "other"].forEach((group) => {
        (layout[group] || []).forEach((key, index) => {
            groupAssignments[key] = {
                group,
                position: group === "main" ? index + 1 : index + 1,
            };
        });
    });

    product.media = product.media.map((media) => {
        const key = getMediaLayoutKey(media);
        const assignment = groupAssignments[key];
        if (!assignment) return media;
        return {
            ...media,
            group: assignment.group,
            position: assignment.position,
        };
    });
}

function updateRemovalBar() {
    const count = Object.keys(pendingRemovals).length;
    const bar = document.getElementById("removalBar");
    const msg = document.getElementById("removalBarMsg");
    if (!bar) return;
    if (count === 0) {
        bar.style.display = "none";
    } else {
        bar.style.display = "flex";
        const selectedCount = Object.values(pendingRemovals).reduce(
            (sum, entry) => sum + (entry.images?.length || 0),
            0,
        );
        if (msg) {
            msg.textContent = `${selectedCount} image${selectedCount !== 1 ? "s" : ""} selected across ${count} product${count !== 1 ? "s" : ""} for removal`;
        }
    }
    // Sync floating push button
    const floatBtn = document.getElementById("floatPushBtn");
    if (floatBtn) {
        if (count > 0) {
            const totalImages = Object.values(pendingRemovals).reduce(
                (s, e) => s + (e.images?.length || 0),
                0,
            );
            floatBtn.disabled = false;
            floatBtn.textContent = `🗑 Remove (${totalImages})`;
        } else {
            // No removals — let updateReorderBar handle the button state
            updateReorderBar();
        }
    }
}

async function pushReordersToShopify() {
    if (Object.keys(pendingRemovals).length > 0) {
        return alert(
            "Removal selections are active. Clear or apply removals before pushing reorders.",
        );
    }

    const shopUrl = document.getElementById("shopUrl").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    if (!shopUrl || !apiKey) {
        return alert(
            "Please fill in Shop URL and API Token on the Sync Dashboard tab first.",
        );
    }
    const handles = Object.keys(pendingReorders);
    if (handles.length === 0) return;

    if (
        !confirm(
            `Bulk update will apply layout changes to:\n\n${handles.map((h) => `• ${h}`).join("\n")}`,
        )
    ) {
        return;
    }

    const reorders = handles.map((h) => ({
        handle: h,
        layout: pendingReorders[h].payload,
    }));

    const btn = document.getElementById("pushReordersBtn");
    const floatBtn = document.getElementById("floatPushBtn");
    const allPushBtns = [btn, floatBtn].filter(Boolean);
    allPushBtns.forEach((b) => {
        b.disabled = true;
        b.textContent = `Pushing ${handles.length}…`;
    });

    try {
        const results = await ipcRenderer.invoke("reorder-product-media", {
            shopUrl,
            apiKey,
            metafields: document.getElementById("metafields").value.trim(),
            reorders,
        });
        const failed = results.filter((r) => !r.success);
        const succeeded = results.filter((r) => r.success);

        succeeded.forEach((r) => {
            if (pendingReorders[r.handle]?.layout) {
                applyPendingLayoutToCachedProduct(
                    r.handle,
                    pendingReorders[r.handle].layout,
                );
            }
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
        } else if (succeeded.length > 0) {
            showCopyableError(
                "Reorder Applied",
                `Changed products:\n${succeeded.map((r) => `• ${r.handle}`).join("\n")}`,
            );
        }

        if (succeeded.length > 0) {
            filterLibrary();
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
    filterLibrary();
}

function floatPushToShopify() {
    if (Object.keys(pendingRemovals).length > 0) {
        pushRemovalsToShopify();
    } else {
        pushReordersToShopify();
    }
}

function resetProductChanges(handle) {
    if (!handle) return;

    delete pendingReorders[handle];
    delete pendingRemovals[handle];

    updateReorderBar();
    updateRemovalBar();
    filterLibrary();
}

function updateDeleteModeButton() {
    const reorderActive = Object.keys(pendingReorders).length > 0;
    // Floating panel delete button
    const floatBtn = document.getElementById("floatDeleteBtn");
    if (floatBtn) {
        if (reorderActive) {
            floatBtn.textContent = "🗑 Delete: OFF";
            floatBtn.classList.remove("active");
            floatBtn.disabled = true;
        } else {
            floatBtn.textContent = deleteMode
                ? "🗑 Delete: ON"
                : "🗑 Delete: OFF";
            floatBtn.classList.toggle("active", deleteMode);
            floatBtn.disabled = false;
        }
    }
    document.querySelectorAll(".media-card").forEach((card) => {
        if (card.dataset.removable === "true") {
            const canDragCard = card.classList.contains("dnd-card");
            card.style.cursor = deleteMode
                ? "pointer"
                : canDragCard
                  ? "grab"
                  : "default";
        }
    });
}

function toggleDeleteMode() {
    if (Object.keys(pendingReorders).length > 0) {
        alert(
            "Reorder changes are active. Clear or push those before entering delete mode.",
        );
        return;
    }
    deleteMode = !deleteMode;
    updateDeleteModeButton();
}

function togglePendingRemoval(handle, folderPath, image, checked) {
    if (Object.keys(pendingReorders).length > 0) {
        alert(
            "Reorder changes are active. Clear or push those before selecting images to remove.",
        );
        return false;
    }

    if (!pendingRemovals[handle]) {
        pendingRemovals[handle] = {
            folderPath,
            images: [],
        };
    }

    const entry = pendingRemovals[handle];
    // Include group in key so the same file used in different slots is tracked independently
    const key = `${image.group || ""}:${image.src || image.filename}`;
    const imageKey = (item) =>
        `${item.group || ""}:${item.src || item.filename}`;

    if (checked) {
        if (!entry.images.some((item) => imageKey(item) === key)) {
            entry.images.push({
                src: image.src,
                filename: image.filename,
                mediaId: image.shopifyId || "",
                fileId: image.shopifyFileId || "",
                group: image.group || "",
            });
        }
    } else {
        entry.images = entry.images.filter((item) => imageKey(item) !== key);
        if (entry.images.length === 0) {
            delete pendingRemovals[handle];
        }
    }

    const productRow = document.querySelector(
        `[data-product-handle="${handle}"]`,
    );
    if (productRow && !pendingReorders[handle]) {
        productRow.style.outline = pendingRemovals[handle]
            ? "2px solid #d32f2f"
            : "";
    }
    updateRemovalBar();
    return true;
}

async function pushRemovalsToShopify() {
    if (Object.keys(pendingReorders).length > 0) {
        return alert(
            "Reorder changes are active. Clear or push those before removing images.",
        );
    }

    const shopUrl = document.getElementById("shopUrl").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    const metafields = document.getElementById("metafields").value.trim();
    if (!shopUrl || !apiKey) {
        return alert(
            "Please fill in Shop URL and API Token on the Sync Dashboard tab first.",
        );
    }

    const removals = Object.entries(pendingRemovals).map(([handle, entry]) => ({
        handle,
        folderPath: entry.folderPath,
        images: entry.images,
    }));

    if (removals.length === 0) return;

    if (
        !confirm(
            `Remove ${removals.reduce((sum, item) => sum + item.images.length, 0)} selected image(s) from Shopify and related metafields? This cannot be undone.`,
        )
    ) {
        return;
    }

    const btn = document.getElementById("pushRemovalsBtn");
    const floatBtn = document.getElementById("floatPushBtn");
    const totalImages = removals.reduce(
        (sum, item) => sum + item.images.length,
        0,
    );
    [btn, floatBtn].filter(Boolean).forEach((b) => {
        b.disabled = true;
        b.textContent = `Removing ${totalImages}…`;
    });

    try {
        const results = await ipcRenderer.invoke("remove-product-images", {
            shopUrl,
            apiKey,
            metafields,
            removals,
        });

        const failed = results.filter((r) => !r.success);
        const succeeded = results.filter((r) => r.success);

        succeeded.forEach((r) => {
            delete pendingRemovals[r.handle];
        });

        if (failed.length > 0) {
            const errorText = `${succeeded.length} removal(s) applied.\n\n${failed.length} failed:\n${failed.map((r) => `• ${r.handle}: ${r.error}`).join("\n")}`;
            showCopyableError("Removal Partially Failed", errorText);
        }

        if (succeeded.length > 0) {
            await loadLocalLibrary(true);
        }
    } catch (err) {
        showCopyableError("Removal Failed", err.message || String(err));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Remove from Shopify";
        }
        updateRemovalBar();
    }
}

function discardRemovals() {
    pendingRemovals = {};
    document.querySelectorAll("[data-product-handle]").forEach((el) => {
        if (!pendingReorders[el.dataset.productHandle]) {
            el.style.outline = "";
        }
    });
    document
        .querySelectorAll(".media-remove-checkbox")
        .forEach((checkbox) => (checkbox.checked = false));
    document
        .querySelectorAll(".media-card-remove-selected")
        .forEach((card) => card.classList.remove("media-card-remove-selected"));
    updateRemovalBar();
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
    // Buttons are in the floating panel; no inline header buttons needed.

    container.innerHTML = `
        <div style="padding:15px; background:#4caf50; color:white; margin-bottom:15px; border-radius:4px;">
            <strong>Gallery Renderer Working</strong><br>
            Products loaded: ${products ? products.length : 0}<br>
            Container: #${containerId}
            ${headerAction}
        </div>
    `;
    updateDeleteModeButton();

    if (!products || products.length === 0) {
        container.innerHTML +=
            '<div style="padding:20px; text-align:center; color:#666; background:white; border:1px solid #ddd;">No products found in this folder. Make sure you selected the correct download path.</div>';
        updateReorderBar();
        updateRemovalBar();
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
            if (pendingReorders[prod.handle]) {
                row.style.outline = "2px solid #ff9800";
            }

            // Header
            const header = document.createElement("div");
            header.style.cssText =
                "display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid #eee; padding-bottom:10px; margin-bottom:10px;";

            // Build Meta Info
            const displayTitle =
                prod.title ||
                prod.productName ||
                prod.handle ||
                "Unknown Product";
            const displayFolder =
                prod.folderName ||
                (prod.folderPath
                    ? path.basename(prod.folderPath)
                    : prod.handle || "");

            let metaHtml = `<div style="font-size:1.1em; font-weight:bold;">${displayTitle}</div>`;
            if (displayFolder) {
                metaHtml += `<div style="font-size:0.9em; color:#777; margin-top:4px;">${displayFolder}</div>`;
            }

            if (prod.sku || prod.category) {
                metaHtml += `<div style="font-size:0.85em; color:#666; margin-top:8px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">`;
                if (prod.sku) metaHtml += `<span>SKU: ${prod.sku}</span>`;
                if (prod.category)
                    metaHtml += `<span style="margin-left:0; background:#e1f5fe; color:#0277bd; padding:2px 6px; border-radius:4px; font-size:0.9em;">${prod.category}</span>`;
                metaHtml += `</div>`;
            }

            header.innerHTML = metaHtml;

            // Add per-product folder opener for quick access in Explorer.
            const folderPath =
                prod.folderPath ||
                (Array.isArray(prod.media) && prod.media.length > 0
                    ? path.dirname(prod.media[0].src)
                    : "");
            const openFolderBtn = document.createElement("button");
            openFolderBtn.className = "product-open-folder-btn";
            openFolderBtn.type = "button";
            openFolderBtn.textContent = "📂";
            openFolderBtn.title = folderPath
                ? `Open folder in Explorer\n${folderPath}`
                : "Folder path unavailable";
            openFolderBtn.disabled = !folderPath;
            openFolderBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (folderPath) openProductFolder(folderPath);
            });

            const resetBtn = document.createElement("button");
            resetBtn.className = "product-reset-btn";
            resetBtn.type = "button";
            resetBtn.textContent = "↺";
            resetBtn.title =
                "Reset pending reorder and removal selections for this product";
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                resetProductChanges(prod.handle);
            });

            const headerActions = document.createElement("div");
            headerActions.className = "product-header-actions";
            headerActions.appendChild(resetBtn);
            headerActions.appendChild(openFolderBtn);
            header.appendChild(headerActions);

            row.appendChild(header);

            // Media Grid
            const grid = document.createElement("div");
            grid.style.cssText =
                "display:flex; flex-direction:column; gap:15px;";
            const mainWrapper = grid; // Alias for internal logic

            if (prod.media && prod.media.length > 0) {
                const groups = getDisplayLayout(prod);
                const canDnd = true;

                const collectCurrentLayout = () => {
                    const baseLayout =
                        pendingReorders[prod.handle]?.layout ||
                        buildOriginalLayout(prod);
                    const layout = {
                        main: [...(baseLayout.main || [])],
                        banner: [...(baseLayout.banner || [])],
                        extra: [...(baseLayout.extra || [])],
                        other: [...(baseLayout.other || [])],
                    };
                    row.querySelectorAll("[data-dnd-group]").forEach(
                        (section) => {
                            const group = section.dataset.dndGroup;
                            layout[group] = [
                                ...section.querySelectorAll(".dnd-card"),
                            ].map((card) => card.dataset.layoutKey);
                        },
                    );

                    return normalizeLayout(layout);
                };

                const syncPendingLayout = () => {
                    const normalized = collectCurrentLayout();
                    const original = buildOriginalLayout(prod);

                    if (layoutsEqual(original, normalized)) {
                        delete pendingReorders[prod.handle];
                        row.style.outline = "";
                    } else {
                        pendingReorders[prod.handle] = {
                            layout: normalized,
                            payload: buildLayoutPayload(prod, normalized),
                        };
                        row.style.outline = "2px solid #ff9800";
                    }

                    updateReorderBar();
                };

                const clearDropMarkers = () => {
                    row.querySelectorAll(".dnd-card").forEach((card) => {
                        card.style.outline = "";
                    });
                };

                const renderSection = (
                    groupName,
                    title,
                    items,
                    isDraggable = false,
                ) => {
                    if (items.length === 0 && !isDraggable) return;

                    const sec = document.createElement("div");
                    const hint = isDraggable
                        ? ' <span style="font-size:10px;color:#aaa;font-weight:400;margin-left:4px;">drag to reorder or move</span>'
                        : "";
                    sec.innerHTML = `<h5 style="margin:0 0 8px 0; color:#555; text-transform:uppercase; font-size:11px; letter-spacing:0.5px; border-bottom:1px solid #eee; padding-bottom:4px;">${title}${hint}</h5>`;

                    const rowDiv = document.createElement("div");
                    rowDiv.style.cssText =
                        "display:flex; flex-wrap:wrap; gap:10px;";
                    rowDiv.dataset.dndGroup = groupName;

                    if (isDraggable) {
                        rowDiv.style.minHeight = "120px";
                        rowDiv.style.padding = "6px";
                        rowDiv.style.border = "1px dashed #d0d7de";
                        rowDiv.style.borderRadius = "6px";
                        rowDiv.style.background = "#fafafa";
                    }

                    if (isDraggable && canDnd) {
                        rowDiv.addEventListener("dragover", (e) => {
                            e.preventDefault();
                            if (Object.keys(pendingRemovals).length > 0) return;
                            const target =
                                e.target.closest &&
                                e.target.closest(".dnd-card");
                            clearDropMarkers();
                            if (target && target !== _dnd.srcEl) {
                                target.style.outline = "2px dashed #008060";
                            }
                        });

                        rowDiv.addEventListener("dragleave", (e) => {
                            if (!rowDiv.contains(e.relatedTarget)) {
                                clearDropMarkers();
                            }
                        });

                        rowDiv.addEventListener("drop", (e) => {
                            e.preventDefault();
                            if (Object.keys(pendingRemovals).length > 0) {
                                alert(
                                    "Removal selections are active. Clear or apply removals before reordering images.",
                                );
                                return;
                            }

                            const bannerHasItem =
                                rowDiv.dataset.dndGroup === "banner" &&
                                rowDiv.querySelectorAll(".dnd-card").length >=
                                    1;
                            if (
                                rowDiv.dataset.dndGroup === "banner" &&
                                bannerHasItem &&
                                _dnd.srcEl &&
                                _dnd.srcEl.parentElement !== rowDiv
                            ) {
                                alert(
                                    "Only one banner image is allowed. Move or remove the existing banner before placing another image there.",
                                );
                                clearDropMarkers();
                                return;
                            }

                            clearDropMarkers();
                            if (!_dnd.srcEl || _dnd.srcHandle !== prod.handle) {
                                return;
                            }

                            let dst =
                                e.target.closest &&
                                e.target.closest(".dnd-card");

                            // If no card was directly hit (e.g. touch landed between cards
                            // or on the row background), find the nearest card by x position
                            if (!dst && e.clientX) {
                                const cards = [
                                    ...rowDiv.querySelectorAll(".dnd-card"),
                                ];
                                let best = null,
                                    bestDist = Infinity;
                                cards.forEach((c) => {
                                    const r = c.getBoundingClientRect();
                                    const cx = r.left + r.width / 2;
                                    const d = Math.abs(e.clientX - cx);
                                    if (d < bestDist) {
                                        bestDist = d;
                                        best = c;
                                    }
                                });
                                if (best) dst = best;
                            }

                            if (
                                dst &&
                                dst !== _dnd.srcEl &&
                                rowDiv.contains(dst)
                            ) {
                                const srcIdx = [...rowDiv.children].indexOf(
                                    _dnd.srcEl,
                                );
                                const dstIdx = [...rowDiv.children].indexOf(
                                    dst,
                                );
                                if (srcIdx < dstIdx) {
                                    rowDiv.insertBefore(
                                        _dnd.srcEl,
                                        dst.nextSibling,
                                    );
                                } else {
                                    rowDiv.insertBefore(_dnd.srcEl, dst);
                                }
                            } else {
                                rowDiv.appendChild(_dnd.srcEl);
                            }

                            syncPendingLayout();
                        });
                    }

                    items.forEach((m) => {
                        const card = document.createElement("div");
                        card.style.cssText =
                            "width:100px; height:100px; border:1px solid #ddd; border-radius:4px; overflow:hidden; position:relative; background:#f0f0f0;";
                        card.classList.add("media-card");

                        const canDragItem =
                            isDraggable &&
                            canDnd &&
                            m.type === "image" &&
                            (!!m.shopifyId || !!m.shopifyFileId);
                        if (canDragItem) {
                            card.draggable = true;
                            card.dataset.layoutKey = getMediaLayoutKey(m);
                            card.style.cursor = deleteMode ? "pointer" : "grab";
                            card.classList.add("dnd-card");
                            card.addEventListener("dragstart", (e) => {
                                if (
                                    deleteMode ||
                                    Object.keys(pendingRemovals).length > 0
                                ) {
                                    e.preventDefault();
                                    return;
                                }
                                _dnd.srcEl = card;
                                _dnd.srcHandle = prod.handle;
                                e.dataTransfer.effectAllowed = "move";
                                setTimeout(() => {
                                    card.style.opacity = "0.4";
                                }, 0);
                            });
                            card.addEventListener("dragend", () => {
                                card.style.opacity = "1";
                                _dnd.srcEl = null;
                                _dnd.srcHandle = null;
                                clearDropMarkers();
                            });
                        }

                        const canRemove =
                            m.type === "image" &&
                            (!!m.shopifyId || !!m.shopifyFileId);
                        card.dataset.removable = canRemove ? "true" : "false";
                        const removalKey = (item) =>
                            `${item.group || ""}:${item.src || item.filename}`;
                        const isSelected = !!pendingRemovals[
                            prod.handle
                        ]?.images?.some(
                            (item) => removalKey(item) === removalKey(m),
                        );
                        if (isSelected) {
                            card.classList.add("media-card-remove-selected");
                        }

                        card.addEventListener("click", (e) => {
                            if (!deleteMode || !canRemove) return;
                            e.stopPropagation();
                            const currentlySelected = !!pendingRemovals[
                                prod.handle
                            ]?.images?.some(
                                (item) => removalKey(item) === removalKey(m),
                            );
                            const changed = togglePendingRemoval(
                                prod.handle,
                                prod.folderPath || path.dirname(m.src),
                                m,
                                !currentlySelected,
                            );
                            if (!changed) return;
                            card.classList.toggle(
                                "media-card-remove-selected",
                                !currentlySelected,
                            );
                        });

                        if (m.status && m.status !== "unchanged") {
                            const badge = document.createElement("div");
                            const normalized = String(
                                m.status || "",
                            ).toLowerCase();
                            let badgeText = normalized.toUpperCase();
                            let background = "#2196f3";
                            let color = "white";

                            if (normalized === "new") {
                                badgeText = "N";
                                background = "#0f9d58";
                            } else if (normalized === "updated") {
                                badgeText = "U";
                                background = "#2196f3";
                            } else if (normalized === "reordered") {
                                badgeText = "R";
                                background = "#e4a100";
                                color = "#202223";
                            } else if (normalized === "deleted_asset") {
                                badgeText = "D";
                                background = "#d32f2f";
                            }

                            badge.style.cssText = `position:absolute; top:0; right:0; background:${background}; color:${color}; font-size:9px; padding:2px 4px; z-index:2;`;
                            badge.textContent = badgeText;
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

                    if (isDraggable && items.length === 0) {
                        const emptyHint = document.createElement("div");
                        emptyHint.style.cssText =
                            "font-size:11px; color:#8a8a8a; padding:8px; align-self:center;";
                        emptyHint.textContent = "Drop images here";
                        rowDiv.appendChild(emptyHint);
                    }

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
                    renderSection("main", "Main Images", groups.main, true);
                    renderSection("banner", "Banners", groups.banner, true);
                    renderSection("extra", "Extras", groups.extra, true);
                    renderSection("other", "Other", groups.other);
                } else if (activeMediaType === "main") {
                    renderSection("main", "Main Images", groups.main, true);
                } else if (activeMediaType === "banner") {
                    renderSection("banner", "Banners", groups.banner, true);
                } else if (activeMediaType === "extra") {
                    renderSection("extra", "Extras", groups.extra, true);
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
    updateReorderBar();
    updateRemovalBar();
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

// ============ EXPORT FUNCTIONS ============

async function testExportProducts() {
    const shopUrl = document.getElementById("shopUrl").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    const metafields = document.getElementById("metafields").value.trim();

    if (!shopUrl || !apiKey) {
        return alert("Please fill in Shop URL and API Token first.");
    }

    const testBtn = document.getElementById("testExportBtn");
    const origText = testBtn.innerText;
    testBtn.disabled = true;
    testBtn.innerText = "Testing...";

    try {
        const result = await ipcRenderer.invoke("test-export-products", {
            shopUrl,
            apiKey,
            metafields,
        });

        // Display results
        const resultsDiv = document.getElementById("exportTestResults");
        const contentDiv = document.getElementById("exportTestContent");

        contentDiv.textContent = JSON.stringify(result, null, 2);
        resultsDiv.style.display = "block";

        console.log("Export test result:", result);
    } catch (e) {
        console.error("Export test error:", e);
        alert("Error during export test: " + e.message);
    } finally {
        testBtn.disabled = false;
        testBtn.innerText = origText;
    }
}

async function exportAllProducts() {
    const shopUrl = document.getElementById("shopUrl").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    const metafields = document.getElementById("metafields").value.trim();

    if (!shopUrl || !apiKey) {
        return alert("Please fill in Shop URL and API Token first.");
    }

    if (
        !confirm(
            "This will export all products from your store to a CSV file. This may take a few minutes depending on your product count. Continue?",
        )
    ) {
        return;
    }

    const exportBtn = document.getElementById("exportBtn");
    const progFill = document.getElementById("progFill");
    const statusText = document.getElementById("statusText");
    const progressArea = document.getElementById("progressArea");

    const origText = exportBtn.innerText;
    exportBtn.disabled = true;
    exportBtn.innerText = "Exporting...";

    // Show progress area
    progressArea.style.display = "block";
    progFill.style.width = "5%";
    statusText.innerText = "Starting export...";

    try {
        const result = await ipcRenderer.invoke("export-all-products", {
            shopUrl,
            apiKey,
            metafields,
        });

        if (result.action === "cancelled") {
            statusText.innerText = "Export cancelled.";
            progFill.style.width = "0%";
            return;
        }

        progFill.style.width = "100%";
        statusText.innerText = `✓ Export Complete! ${result.productCount} products exported.`;

        if (result.action === "copied") {
            alert(
                `Export Complete!\n${result.productCount} products copied to clipboard.\n\nPaste directly into Excel or Google Sheets.`,
            );
        } else {
            alert(
                `Export Complete!\nFile saved to:\n${result.filepath}\n\nProducts exported: ${result.productCount}`,
            );
        }
        console.log("Export result:", result);

        // Hide progress after 2 seconds
        setTimeout(() => {
            progressArea.style.display = "none";
        }, 2000);
    } catch (e) {
        console.error("Export error:", e);
        statusText.innerText = `ERROR: ${e.message}`;
        progFill.style.width = "0%";
        alert("Error during export: " + e.message);

        // Hide progress after 3 seconds
        setTimeout(() => {
            progressArea.style.display = "none";
        }, 3000);
    } finally {
        exportBtn.disabled = false;
        exportBtn.innerText = origText;
    }
}

function copyExportTestResults() {
    const content = document.getElementById("exportTestContent").textContent;
    navigator.clipboard
        .writeText(content)
        .then(() => {
            alert("Test results copied to clipboard!");
        })
        .catch((err) => {
            console.error("Failed to copy:", err);
            alert("Failed to copy to clipboard");
        });
}

// Initialize search listener after DOM is fully loaded
function initSearchListener() {
    const searchInput = document.getElementById("libSearch");
    if (searchInput) {
        // Use change and keyup events for better reliability
        const debouncedFilter = debounce(() => {
            filterLibrary();
        }, 300);

        searchInput.addEventListener("input", debouncedFilter);
        searchInput.addEventListener("keyup", debouncedFilter);

        // Also accept Enter key for immediate search
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                filterLibrary();
            }
        });
    }
}

// Attach search listener after DOM is loaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSearchListener);
} else {
    initSearchListener();
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
