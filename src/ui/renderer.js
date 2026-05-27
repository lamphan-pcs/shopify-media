const { ipcRenderer } = require("electron");
const path = require("path"); // Load path module at top level

// Numpad selections: { [handle]: Set<number> }
function _loadNumpadSelections() {
    try {
        const raw = localStorage.getItem("productNumpadSelections");
        if (!raw) return {};
        const plain = JSON.parse(raw); // { handle: [n, n, ...] }
        const result = {};
        for (const [h, arr] of Object.entries(plain)) {
            result[h] = new Set(arr);
        }
        return result;
    } catch {
        return {};
    }
}
function _saveNumpadSelections() {
    const plain = {};
    for (const [h, s] of Object.entries(productNumpadSelections)) {
        if (s.size > 0) plain[h] = [...s];
    }
    localStorage.setItem("productNumpadSelections", JSON.stringify(plain));
}
let productNumpadSelections = _loadNumpadSelections();

// Media type filter state — multi-select Set of active types
const _allMediaTypes = ["main", "banner", "extra", "plus"];
const _savedMediaTypes = localStorage.getItem("activeMediaTypes");
let activeMediaTypes = _savedMediaTypes
    ? new Set(JSON.parse(_savedMediaTypes))
    : new Set(_allMediaTypes);
let floatingLibraryHidden =
    localStorage.getItem("floatingLibraryHidden") === "1";

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

function isLibraryTabActive() {
    const libraryTab = document.getElementById("tab-library");
    return !!libraryTab && libraryTab.classList.contains("active");
}

function updateFloatingLibraryUi() {
    const isLibrary = isLibraryTabActive();
    const floatingPanel = document.getElementById("floatingLibraryPanel");
    const toggleBtn = document.getElementById("floatingLibraryToggle");

    document.body.classList.toggle("library-active", isLibrary);
    document.body.classList.toggle(
        "floating-tools-hidden",
        isLibrary && floatingLibraryHidden,
    );

    if (floatingPanel) {
        floatingPanel.classList.toggle("visible", isLibrary);
        floatingPanel.classList.toggle("hidden-by-user", floatingLibraryHidden);
    }

    if (toggleBtn) {
        toggleBtn.classList.toggle("visible", isLibrary);
        toggleBtn.textContent = floatingLibraryHidden ? "▶ Tools" : "◀ Tools";
        toggleBtn.title = floatingLibraryHidden
            ? "Show floating library tools"
            : "Hide floating library tools";
    }
}

function toggleFloatingLibraryPanel() {
    floatingLibraryHidden = !floatingLibraryHidden;
    localStorage.setItem(
        "floatingLibraryHidden",
        floatingLibraryHidden ? "1" : "0",
    );
    updateFloatingLibraryUi();
}

function recoverLibrarySearchFocusability() {
    setTimeout(() => {
        const searchInput = document.getElementById("libSearch");
        if (!searchInput) return;
        // Don't touch libSearch while multi-search mode is active
        const multiPanel = document.getElementById("multiSearchPanel");
        if (multiPanel && multiPanel.style.display !== "none") return;
        searchInput.disabled = false;
        searchInput.readOnly = false;
        searchInput.style.pointerEvents = "auto";

        if (isLibraryTabActive()) {
            // Ensure the input can immediately accept typing after native dialogs.
            searchInput.focus();
        }
    }, 30);
}

// Keep search focus working after native dialogs (alert/confirm/showOpenDialog/showSaveDialog)
const _nativeAlert = window.alert.bind(window);
window.alert = (...args) => {
    _nativeAlert(...args);
    recoverLibrarySearchFocusability();
};

const _nativeConfirm = window.confirm.bind(window);
window.confirm = (...args) => {
    const result = _nativeConfirm(...args);
    recoverLibrarySearchFocusability();
    return result;
};

window.addEventListener("focus", () => {
    recoverLibrarySearchFocusability();
});

document.addEventListener(
    "pointerdown",
    (event) => {
        const searchInput = document.getElementById("libSearch");
        if (!searchInput || event.target !== searchInput) return;

        setTimeout(() => {
            if (document.activeElement !== searchInput) {
                searchInput.focus();
            }
        }, 0);
    },
    true,
);

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

    updateFloatingLibraryUi();

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
        updateFloatingLibraryUi();

        if (tabName === "library") {
            // Slight delay to ensure DOM is painted
            setTimeout(() => {
                console.log("Triggering loadLocalLibrary from switchTab");
                initMediaTypeButtons(); // Initialize button states
                loadLocalLibrary(true);
            }, 50);
        }

        if (tabName === "pushplus") {
            setTimeout(() => renderPushPlusTab(), 50);
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

function toggleMultiSearch() {
    const panel = document.getElementById("multiSearchPanel");
    const btn = document.getElementById("multiSearchToggle");
    const singleInput = document.getElementById("libSearch");
    if (!panel || !btn) return;
    const isOpen = panel.style.display !== "none";
    if (isOpen) {
        panel.style.display = "none";
        btn.classList.remove("active");
        btn.textContent = "☰ List Search";
        singleInput.disabled = false;
    } else {
        panel.style.display = "block";
        btn.classList.add("active");
        btn.textContent = "✕ List Search";
        singleInput.disabled = true;
        singleInput.value = "";
        document.getElementById("libMultiSearch").focus();
        filterLibrary();
    }
}

function filterLibrary() {
    const query = document.getElementById("libSearch").value.toLowerCase();
    const category = document
        .getElementById("categoryFilter")
        .value.toLowerCase();

    // ── Multi-search mode ────────────────────────────────────────────────────
    const multiPanel = document.getElementById("multiSearchPanel");
    const multiActive = multiPanel && multiPanel.style.display !== "none";
    if (multiActive) {
        const rawLines = document.getElementById("libMultiSearch").value;
        const terms = rawLines
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

        const notFoundEl = document.getElementById("multiSearchNotFound");

        if (terms.length === 0) {
            if (notFoundEl) notFoundEl.style.display = "none";
            renderGallery([], "fullLibraryArea");
            return;
        }

        const excludeTiktok = document.getElementById("excludeTiktok")?.checked;
        const isTiktokProduct = (p) =>
            (p.title && p.title.toLowerCase().includes("tiktok")) ||
            (p.productName && p.productName.toLowerCase().includes("tiktok")) ||
            (p.folderName && p.folderName.toLowerCase().includes("tiktok"));

        // Match each term to a product (exact first, then contains fallback)
        const matchProduct = (term) => {
            const t = term.toLowerCase();
            const allowed = (p) => !(excludeTiktok && isTiktokProduct(p));
            // Exact match on handle or sku
            let hit = cachedLibrary.find(
                (p) =>
                    allowed(p) &&
                    ((p.handle && p.handle.toLowerCase() === t) ||
                        (p.sku && p.sku.toLowerCase() === t) ||
                        (p.folderName && p.folderName.toLowerCase() === t)),
            );
            if (!hit) {
                // Contains fallback
                hit = cachedLibrary.find(
                    (p) =>
                        allowed(p) &&
                        ((p.handle && p.handle.toLowerCase().includes(t)) ||
                            (p.sku && p.sku.toLowerCase().includes(t)) ||
                            (p.folderName &&
                                p.folderName.toLowerCase().includes(t)) ||
                            (p.title && p.title.toLowerCase().includes(t)) ||
                            (p.productName &&
                                p.productName.toLowerCase().includes(t))),
                );
            }
            return hit || null;
        };

        const notFound = [];
        const seen = new Set();
        const ordered = [];

        for (const term of terms) {
            const prod = matchProduct(term);
            if (prod) {
                const key = prod.handle || prod.sku || prod.title;
                if (!seen.has(key)) {
                    seen.add(key);
                    ordered.push(prod);
                }
            } else {
                notFound.push(term);
            }
        }

        // Show not-found banner
        if (notFoundEl) {
            if (notFound.length > 0) {
                notFoundEl.style.display = "block";
                notFoundEl.innerHTML =
                    `<strong>⚠ Not found (${notFound.length}):</strong> ` +
                    notFound
                        .map(
                            (t) =>
                                `<span style="display:inline-block;background:#ffc107;color:#333;border-radius:4px;padding:1px 7px;margin:2px 3px;font-family:monospace;font-size:12px;">${t}</span>`,
                        )
                        .join("");
            } else {
                notFoundEl.style.display = "none";
            }
        }

        renderGallery(ordered, "fullLibraryArea");
        return;
    }
    // ── End multi-search ─────────────────────────────────────────────────────

    const excludeTiktok = document.getElementById("excludeTiktok")?.checked;

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

        // 3. Exclude TikTok products
        const isTiktok =
            (p.title && p.title.toLowerCase().includes("tiktok")) ||
            (p.productName && p.productName.toLowerCase().includes("tiktok")) ||
            (p.folderName && p.folderName.toLowerCase().includes("tiktok"));
        if (excludeTiktok && isTiktok) return false;

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
    if (type === "all") {
        // "All" resets to showing every type
        activeMediaTypes = new Set(_allMediaTypes);
    } else {
        if (activeMediaTypes.has(type)) {
            activeMediaTypes.delete(type);
            // If nothing left selected, restore all
            if (activeMediaTypes.size === 0) {
                activeMediaTypes = new Set(_allMediaTypes);
            }
        } else {
            activeMediaTypes.add(type);
        }
    }
    localStorage.setItem(
        "activeMediaTypes",
        JSON.stringify([...activeMediaTypes]),
    );
    initMediaTypeButtons();
    filterLibrary();
}

function getCheckedExportTypes() {
    const allBox = document.getElementById("exportTypeAll");
    const mainBox = document.getElementById("exportTypeMain");
    const bannerBox = document.getElementById("exportTypeBanner");
    const extraBox = document.getElementById("exportTypeExtra");
    const plusBox = document.getElementById("exportTypePlus");

    if (allBox && allBox.checked) {
        return ["all"];
    }

    const selected = [];
    if (mainBox && mainBox.checked) selected.push("main");
    if (bannerBox && bannerBox.checked) selected.push("banner");
    if (extraBox && extraBox.checked) selected.push("extra");
    if (plusBox && plusBox.checked) selected.push("plus");
    return selected;
}

function syncExportTypeAllBehavior() {
    const allBox = document.getElementById("exportTypeAll");
    const subBoxes = [
        document.getElementById("exportTypeMain"),
        document.getElementById("exportTypeBanner"),
        document.getElementById("exportTypeExtra"),
        document.getElementById("exportTypePlus"),
    ].filter(Boolean);

    if (!allBox) return;

    if (allBox.checked) {
        subBoxes.forEach((box) => {
            box.checked = true;
            box.disabled = true;
        });
    } else {
        subBoxes.forEach((box) => {
            box.disabled = false;
        });
    }
}

// ============ PUSH PLUS TAB ============

function _buildLibPushPlusPanel(panel, prod) {
    const shopUrl = localStorage.getItem("lastShop") || "";
    const apiKey = localStorage.getItem("lastKey") || "";
    const metafieldsStr = localStorage.getItem("lastMetafields") || "";
    const hasCredentials = shopUrl && apiKey;

    const layout = getDisplayLayout(prod);

    // Collect candidates from main / banner / extra
    const candidates = [];
    const addGroup = (items, groupLabel) => {
        (items || []).forEach((item) => {
            const gid = item.shopifyId || item.shopifyFileId || "";
            if (!item.src || !gid) return;
            candidates.push({
                id: gid,
                group: groupLabel,
                displayUrl: "file://" + item.src.replace(/\\/g, "/"),
            });
        });
    };
    addGroup(layout.main, "main");
    addGroup(layout.banner, "banner");
    addGroup(layout.extra, "extra");

    if (candidates.length === 0) {
        panel.innerHTML =
            '<div style="color:#888;font-size:12px;">No main/banner/extra images with Shopify GIDs found. Sync first.</div>';
        return;
    }

    const existingPlusCount = layout.plus ? layout.plus.length : 0;

    const label = document.createElement("div");
    label.className = "lib-pp-panel-label";
    label.textContent =
        existingPlusCount > 0
            ? `Click images to select (ordered). Drag to reorder. Will append to ${existingPlusCount} existing plus image(s).`
            : "Click images to select (in order). Drag to reorder. Selected images will be pushed as plus content.";
    panel.appendChild(label);

    const strip = document.createElement("div");
    strip.className = "lib-pp-strip";

    let selectedOrder = []; // candidate indices

    const footer = document.createElement("div");
    footer.className = "lib-pp-footer";

    const resultSpan = document.createElement("span");
    resultSpan.className = "lib-pp-result";

    const pushBtn = document.createElement("button");
    pushBtn.className = "lib-pp-push-btn";
    pushBtn.textContent =
        existingPlusCount > 0 ? "Append to Shopify" : "Push to Shopify";
    pushBtn.disabled = true;
    if (!hasCredentials)
        pushBtn.title = "Enter Shop URL and API key in the dashboard first";

    const refreshOrder = () => {
        strip.querySelectorAll(".lib-pp-thumb").forEach((thumb) => {
            const idx = parseInt(thumb.dataset.idx);
            const pos = selectedOrder.indexOf(idx);
            const ob = thumb.querySelector(".lib-pp-order");
            if (pos >= 0) {
                thumb.classList.add("selected");
                if (ob) ob.textContent = pos + 1;
            } else {
                thumb.classList.remove("selected");
            }
        });
        const n = selectedOrder.length;
        pushBtn.textContent =
            n > 0
                ? `${existingPlusCount > 0 ? "Append" : "Push"} ${n} image(s)`
                : existingPlusCount > 0
                  ? "Append to Shopify"
                  : "Push to Shopify";
        pushBtn.disabled = !hasCredentials || n === 0;
    };

    let dragSrc = null;
    candidates.forEach((cand, idx) => {
        const thumb = document.createElement("div");
        thumb.className = "lib-pp-thumb";
        thumb.dataset.idx = idx;
        thumb.draggable = true;

        const img = document.createElement("img");
        img.src = cand.displayUrl;
        img.alt = cand.group;
        img.loading = "lazy";

        const badge = document.createElement("span");
        badge.className = "lib-pp-badge";
        badge.textContent = cand.group;

        const orderBadge = document.createElement("span");
        orderBadge.className = "lib-pp-order";

        thumb.appendChild(img);
        thumb.appendChild(badge);
        thumb.appendChild(orderBadge);

        thumb.addEventListener("click", () => {
            const pos = selectedOrder.indexOf(idx);
            if (pos >= 0) selectedOrder.splice(pos, 1);
            else selectedOrder.push(idx);
            refreshOrder();
        });

        thumb.addEventListener("dragstart", (e) => {
            if (!thumb.classList.contains("selected")) {
                e.preventDefault();
                return;
            }
            dragSrc = idx;
            thumb.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
        });
        thumb.addEventListener("dragend", () => {
            thumb.classList.remove("dragging");
            strip.classList.remove("drag-over");
        });
        thumb.addEventListener("dragover", (e) => {
            e.preventDefault();
            strip.classList.add("drag-over");
        });
        thumb.addEventListener("dragleave", () =>
            strip.classList.remove("drag-over"),
        );
        thumb.addEventListener("drop", (e) => {
            e.preventDefault();
            strip.classList.remove("drag-over");
            if (dragSrc === null || dragSrc === idx) return;
            const from = selectedOrder.indexOf(dragSrc);
            const to = selectedOrder.indexOf(idx);
            if (from < 0 || to < 0) return;
            selectedOrder.splice(from, 1);
            selectedOrder.splice(to, 0, dragSrc);
            dragSrc = null;
            refreshOrder();
        });

        strip.appendChild(thumb);
    });

    panel.appendChild(strip);

    pushBtn.addEventListener("click", async () => {
        if (selectedOrder.length === 0) return;
        const mediaIds = selectedOrder
            .map((i) => candidates[i].id)
            .filter(Boolean);
        if (!mediaIds.length) {
            resultSpan.className = "lib-pp-result err";
            resultSpan.textContent = "No Shopify GIDs available.";
            return;
        }
        pushBtn.disabled = true;
        pushBtn.textContent = "Pushing...";
        resultSpan.textContent = "";
        try {
            const result = await ipcRenderer.invoke("set-plus-metafield", {
                shopUrl,
                apiKey,
                metafields: metafieldsStr,
                handle: prod.handle,
                mediaIds,
                append: true,
            });
            resultSpan.className = "lib-pp-result ok";
            resultSpan.textContent = `✓ ${result.appended ? "Appended" : "Pushed"} ${result.count} image(s) (total: ${result.total})`;
            pushBtn.textContent = "Done!";
        } catch (err) {
            console.error("[LibPushPlus] Failed:", err);
            resultSpan.className = "lib-pp-result err";
            resultSpan.textContent = `✗ ${err.message}`;
            pushBtn.disabled = false;
            refreshOrder();
        }
    });

    footer.appendChild(pushBtn);
    footer.appendChild(resultSpan);
    panel.appendChild(footer);
}

function renderPushPlusTab() {
    const container = document.getElementById("pushPlusContainer");
    const statusEl = document.getElementById("pushPlusStatus");
    if (!container) return;

    if (!cachedLibrary || cachedLibrary.length === 0) {
        container.innerHTML =
            '<div style="color:#888; padding:20px;">No library loaded. Go to Full Library tab and click Rescan first.</div>';
        return;
    }

    // Filter to products with 0 plus images
    const query = (
        document.getElementById("ppSearch")?.value || ""
    ).toLowerCase();
    const category = (
        document.getElementById("ppCategoryFilter")?.value || ""
    ).toLowerCase();

    const products = cachedLibrary.filter((prod) => {
        if (query) {
            const matchesText =
                (prod.title && prod.title.toLowerCase().includes(query)) ||
                (prod.handle && prod.handle.toLowerCase().includes(query)) ||
                (prod.sku && prod.sku.toLowerCase().includes(query)) ||
                (prod.tags &&
                    prod.tags.some((t) => t.toLowerCase().includes(query)));
            if (!matchesText) return false;
        }

        if (category) {
            const matchesCategory =
                (prod.category && prod.category.toLowerCase() === category) ||
                (prod.tags && prod.tags.includes(category));
            if (!matchesCategory) return false;
        }

        return true;
    });

    const totalNoPlus = cachedLibrary.filter((p) => {
        const l = getDisplayLayout(p);
        return !l.plus || l.plus.length === 0;
    }).length;

    if (statusEl) {
        statusEl.textContent = `Showing ${products.length} of ${cachedLibrary.length} products (${totalNoPlus} have no plus content).`;
        statusEl.style.cssText = "color:#666; font-size:12px;";
    }

    if (products.length === 0) {
        container.innerHTML =
            '<div style="color:#008060; padding:20px; font-weight:600;">No matching products. Try clearing the search or category filter.</div>';
        return;
    }

    container.innerHTML = "";

    const shopUrl = localStorage.getItem("lastShop") || "";
    const apiKey = localStorage.getItem("lastKey") || "";
    const metafieldsStr = localStorage.getItem("lastMetafields") || "";
    const hasCredentials = shopUrl && apiKey;

    products.forEach((prod) => {
        const layout = getDisplayLayout(prod);

        // Collect all available images from main / banner / extra
        const candidates = [];
        const pushToGroup = (items, groupLabel) => {
            (items || []).forEach((item) => {
                const shopifyGid = item.shopifyId || item.shopifyFileId || "";
                const displayUrl = item.src
                    ? "file://" + item.src.replace(/\\/g, "/")
                    : null;
                // Need at least a display URL and a Shopify GID to push
                if (!displayUrl || !shopifyGid) return;
                candidates.push({
                    id: shopifyGid,
                    group: groupLabel,
                    displayUrl,
                });
            });
        };
        pushToGroup(layout.main, "main");
        pushToGroup(layout.banner, "banner");
        pushToGroup(layout.extra, "extra");

        if (candidates.length === 0) return; // No source images — skip

        // Per-product selected order state
        let selectedOrder = []; // array of candidate indices in chosen order

        const card = document.createElement("div");
        card.className = "pp-card";

        // Header
        const header = document.createElement("div");
        header.className = "pp-card-header";
        const titleWrap = document.createElement("div");
        const existingPlusCount = layout.plus ? layout.plus.length : 0;
        const existingLabel =
            existingPlusCount > 0
                ? `<span style="background:#e8f5e9;color:#2e7d32;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;margin-left:6px;">${existingPlusCount} existing plus</span>`
                : `<span style="background:#fff3e0;color:#e65100;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;margin-left:6px;">no plus yet</span>`;
        titleWrap.innerHTML = `<span class="pp-card-title">${prod.title || prod.handle}</span>${existingLabel}
            <span class="pp-card-meta">${prod.handle} &mdash; ${candidates.length} source image(s)</span>`;

        const rightWrap = document.createElement("div");
        rightWrap.style.cssText = "display:flex; align-items:center; gap:8px;";

        const resultSpan = document.createElement("span");
        resultSpan.className = "pp-result";

        const pushBtn = document.createElement("button");
        pushBtn.className = "pp-push-btn";
        pushBtn.textContent =
            layout.plus && layout.plus.length > 0
                ? "Append to Shopify"
                : "Push to Shopify";
        pushBtn.disabled = !hasCredentials;
        if (!hasCredentials)
            pushBtn.title = "Enter Shop URL and API key in the dashboard first";

        rightWrap.appendChild(resultSpan);
        rightWrap.appendChild(pushBtn);
        header.appendChild(titleWrap);
        header.appendChild(rightWrap);
        card.appendChild(header);

        // Source label
        const srcLabel = document.createElement("div");
        srcLabel.className = "pp-source-label";
        srcLabel.textContent =
            "Click images to select (in order). Drag to reorder. Selected images will be pushed as plus content.";
        card.appendChild(srcLabel);

        // Image strip
        const strip = document.createElement("div");
        strip.className = "pp-img-strip";

        const refreshOrder = () => {
            strip.querySelectorAll(".pp-thumb").forEach((thumb) => {
                const idx = parseInt(thumb.dataset.idx);
                const pos = selectedOrder.indexOf(idx);
                const orderBadge = thumb.querySelector(".pp-thumb-order");
                if (pos >= 0) {
                    thumb.classList.add("selected");
                    if (orderBadge) orderBadge.textContent = pos + 1;
                } else {
                    thumb.classList.remove("selected");
                }
            });
            pushBtn.textContent =
                selectedOrder.length > 0
                    ? `${layout.plus && layout.plus.length > 0 ? "Append" : "Push"} ${selectedOrder.length} image(s) to Shopify`
                    : layout.plus && layout.plus.length > 0
                      ? "Append to Shopify"
                      : "Push to Shopify";
            pushBtn.disabled = !hasCredentials || selectedOrder.length === 0;
        };

        candidates.forEach((cand, idx) => {
            const thumb = document.createElement("div");
            thumb.className = "pp-thumb";
            thumb.dataset.idx = idx;
            thumb.draggable = true;

            const img = document.createElement("img");
            img.src = cand.displayUrl;
            img.alt = cand.group;
            img.loading = "lazy";

            const badge = document.createElement("span");
            badge.className = "pp-thumb-badge";
            badge.textContent = cand.group;

            const orderBadge = document.createElement("span");
            orderBadge.className = "pp-thumb-order";

            thumb.appendChild(img);
            thumb.appendChild(badge);
            thumb.appendChild(orderBadge);

            // Click to toggle selection
            thumb.addEventListener("click", () => {
                const pos = selectedOrder.indexOf(idx);
                if (pos >= 0) {
                    selectedOrder.splice(pos, 1);
                } else {
                    selectedOrder.push(idx);
                }
                refreshOrder();
            });

            // Drag-to-reorder (only among selected)
            let dragSrcIdx = null;
            thumb.addEventListener("dragstart", (e) => {
                if (!thumb.classList.contains("selected")) {
                    e.preventDefault();
                    return;
                }
                dragSrcIdx = idx;
                thumb.classList.add("dragging");
                e.dataTransfer.effectAllowed = "move";
            });
            thumb.addEventListener("dragend", () => {
                thumb.classList.remove("dragging");
                strip.classList.remove("drag-over");
            });
            thumb.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                strip.classList.add("drag-over");
            });
            thumb.addEventListener("dragleave", () => {
                strip.classList.remove("drag-over");
            });
            thumb.addEventListener("drop", (e) => {
                e.preventDefault();
                strip.classList.remove("drag-over");
                if (dragSrcIdx === null || dragSrcIdx === idx) return;
                const fromPos = selectedOrder.indexOf(dragSrcIdx);
                const toPos = selectedOrder.indexOf(idx);
                if (fromPos < 0 || toPos < 0) return; // one not selected
                selectedOrder.splice(fromPos, 1);
                selectedOrder.splice(toPos, 0, dragSrcIdx);
                dragSrcIdx = null;
                refreshOrder();
            });

            strip.appendChild(thumb);
        });

        card.appendChild(strip);

        // Push handler
        pushBtn.addEventListener("click", async () => {
            if (selectedOrder.length === 0) return;
            const mediaIds = selectedOrder
                .map((i) => candidates[i].id)
                .filter(Boolean);
            if (mediaIds.length === 0) {
                resultSpan.className = "pp-result err";
                resultSpan.textContent =
                    "No Shopify GIDs available for selected images.";
                return;
            }
            pushBtn.disabled = true;
            pushBtn.textContent = "Pushing...";
            resultSpan.textContent = "";
            try {
                const result = await ipcRenderer.invoke("set-plus-metafield", {
                    shopUrl,
                    apiKey,
                    metafields: metafieldsStr,
                    handle: prod.handle,
                    mediaIds,
                    append: true,
                });
                resultSpan.className = "pp-result ok";
                resultSpan.textContent = `✓ ${result.appended ? "Appended" : "Pushed"} ${result.count} image(s) (total: ${result.total})`;
                pushBtn.textContent = "Done!";
            } catch (err) {
                console.error("[PushPlus] Failed:", err);
                resultSpan.className = "pp-result err";
                resultSpan.textContent = `✗ ${err.message}`;
                pushBtn.disabled = false;
                pushBtn.textContent = `Push ${selectedOrder.length} image(s) to Shopify`;
            }
        });

        container.appendChild(card);
    });

    if (container.children.length === 0) {
        container.innerHTML =
            '<div style="color:#888; padding:20px;">No products with available source images found.</div>';
    }
}

async function exportNumpadSelections() {
    const rows = cachedLibrary.map((prod) => {
        const sel = productNumpadSelections[prod.handle];
        const nums =
            sel && sel.size > 0
                ? [...sel].sort((a, b) => a - b).join("|")
                : null;
        const layout = getDisplayLayout(prod);
        const plusCount = layout.plus ? layout.plus.length : 0;
        return {
            handle: prod.handle,
            title: prod.title || prod.productName || prod.handle || "",
            numbers: nums,
            plusCount,
        };
    });

    const escCsv = (v) =>
        v === null ? "null" : `"${String(v).replace(/"/g, '""')}"`;
    const header = "Handle,Title,Plus Image Count,Selected Numbers";
    const body = rows
        .map((r) =>
            [
                escCsv(r.handle),
                escCsv(r.title),
                r.plusCount,
                escCsv(r.numbers),
            ].join(","),
        )
        .join("\n");
    const csv = header + "\n" + body;

    try {
        const result = await ipcRenderer.invoke("export-numpad-selections", {
            csv,
            rowCount: rows.length,
        });
        if (result?.action === "saved") {
            alert(`Exported ${result.rowCount} row(s) to:\n${result.filepath}`);
        } else if (result?.action === "copied") {
            alert(`${result.rowCount} row(s) copied to clipboard.`);
        }
    } catch (err) {
        console.error("Export numpad failed:", err);
        alert("Error exporting: " + (err.message || String(err)));
    }
}

async function exportPlusContent() {
    if (!selectedPath) {
        return alert("Please select a source folder first.");
    }

    const btn = document.getElementById("exportPlusBtn");
    const origText = btn ? btn.textContent : "Export Plus CSV";
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Exporting...";
    }

    try {
        const result = await ipcRenderer.invoke("export-plus-content", {
            folderPath: selectedPath,
        });

        if (!result || !result.success) {
            if (result?.reason === "no-plus-content") {
                alert(
                    "No Plus (more_description) images found in the manifest.",
                );
            }
            return;
        }

        if (result.action === "saved") {
            alert(`Exported ${result.rowCount} row(s) to:\n${result.filepath}`);
        } else if (result.action === "copied") {
            alert(`${result.rowCount} row(s) copied to clipboard.`);
        }
    } catch (err) {
        console.error("Export plus content failed:", err);
        alert("Error exporting Plus content: " + (err.message || String(err)));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }
}

async function exportCheckedLibraryImages() {
    if (!selectedPath) {
        return alert("Please select a source folder first.");
    }

    const selectedTypes = getCheckedExportTypes();
    if (!selectedTypes.length) {
        return alert("Please check at least one image type to export.");
    }

    const btn = document.getElementById("exportLibraryBtn");
    const floatBtn = document.getElementById("floatExportBtn");
    const allBtns = [btn, floatBtn].filter(Boolean);
    const originalTexts = new Map(allBtns.map((b) => [b, b.textContent]));

    allBtns.forEach((b) => {
        b.disabled = true;
        b.textContent = "Exporting...";
    });

    try {
        const result = await ipcRenderer.invoke("export-library-images", {
            sourceRoot: selectedPath,
            selectedTypes,
        });

        if (!result || result.cancelled) {
            return;
        }

        alert(
            `Export complete.\n\nDestination: ${result.destinationRoot}\nFolders scanned: ${result.visitedFolders}\nMatched files: ${result.matchedFiles}\nCopied files: ${result.copiedFiles}`,
        );
    } catch (err) {
        console.error("Export images failed:", err);
        alert("Error exporting images: " + (err.message || String(err)));
    } finally {
        allBtns.forEach((b) => {
            b.disabled = false;
            b.textContent = originalTexts.get(b) || "Export Images";
        });
    }
}

// Initialize media type button states on page load
function initMediaTypeButtons() {
    const allActive = _allMediaTypes.every((t) => activeMediaTypes.has(t));

    const allBtn = document.getElementById("mediaTypeAll");
    if (allBtn) allBtn.classList.toggle("active", allActive);

    _allMediaTypes.forEach((type) => {
        const id = "mediaType" + type.charAt(0).toUpperCase() + type.slice(1);
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle("active", activeMediaTypes.has(type));
    });

    syncExportTypeAllBehavior();
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
        plus: [...(layout.plus || [])],
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
    const groups = { main: [], banner: [], extra: [], plus: [], other: [] };
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
        const key = getMediaLayoutKey(media);
        // Within-group dedup: the same GID may appear in multiple groups but
        // should never be listed twice inside the same group.
        if (!groups[group].includes(key)) {
            groups[group].push(key);
        }
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
    // Build a group-aware lookup so the same GID can be found in its correct
    // group (e.g. one gid:// can appear as main AND banner AND extra).
    const groupMaps = {};
    (prod.media || []).forEach((media) => {
        const g = media.group || "other";
        if (!groupMaps[g]) groupMaps[g] = new Map();
        groupMaps[g].set(getMediaLayoutKey(media), media);
    });
    const itemMap = getLayoutItemMap(prod); // fallback global map

    const storedLayout = pendingReorders[prod.handle]?.layout;
    const layout = storedLayout || buildOriginalLayout(prod);
    const display = { main: [], banner: [], extra: [], plus: [], other: [] };

    // Track placements as "key\x00group" composites so the same GID can
    // legitimately occupy multiple groups while still being deduplicated
    // within a single group.
    const placed = new Set();

    ["main", "banner", "extra", "plus", "other"].forEach((group) => {
        (layout[group] || []).forEach((key) => {
            const composite = `${key}\x00${group}`;
            if (placed.has(composite)) return; // within-group dedup only
            placed.add(composite);
            // Prefer the item that was originally assigned to this group;
            // fall back to any item with this key if no group-specific one exists.
            const item =
                (groupMaps[group] && groupMaps[group].get(key)) ||
                itemMap.get(key);
            if (item) {
                // Clone with the correct group so rendering labels it properly.
                display[group].push(
                    item.group === group ? item : { ...item, group },
                );
            }
        });
    });

    // Append media items not yet placed in their designated group at all
    // (orphaned/newly downloaded files not in any layout).
    (prod.media || []).forEach((media) => {
        const key = getMediaLayoutKey(media);
        const g =
            media.group && display[media.group] !== undefined
                ? media.group
                : "other";
        const composite = `${key}\x00${g}`;
        if (!placed.has(composite)) {
            placed.add(composite);
            display[g].push(media);
        }
    });

    return display;
}

function layoutsEqual(left, right) {
    const groups = ["main", "banner", "extra", "plus", "other"];
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
        plus: (layout.plus || []).map(toPayload).filter(Boolean),
    };
}

function applyPendingLayoutToCachedProduct(handle, layout) {
    const product = cachedLibrary.find((item) => item.handle === handle);
    if (!product || !Array.isArray(product.media)) return;

    const itemMap = getLayoutItemMap(product);
    const groupAssignments = {};

    // Track keys that appear in multiple groups (cross-group clones into plus)
    const keyCounts = {};
    ["main", "banner", "extra", "plus", "other"].forEach((group) => {
        (layout[group] || []).forEach((key) => {
            keyCounts[key] = (keyCounts[key] || 0) + 1;
        });
    });

    ["main", "banner", "extra", "plus", "other"].forEach((group) => {
        (layout[group] || []).forEach((key, index) => {
            // If a key appears in multiple groups, only assign it to the non-plus group
            // (plus is additive — it doesn't move the item out of its original group)
            if (keyCounts[key] > 1 && group === "plus") return;
            groupAssignments[key] = {
                group,
                position: index + 1,
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
            const syntheticId = String(
                image.shopifyFileId || image.shopifyId || "",
            );
            entry.images.push({
                src: image.src,
                filename: image.filename,
                mediaId: image.shopifyId || "",
                fileId: image.shopifyFileId || "",
                syntheticId: syntheticId.startsWith("meta-json:")
                    ? syntheticId
                    : "",
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
        const downloadVideosInput = document.getElementById("downloadVideos");

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
        const downloadVideos = downloadVideosInput
            ? downloadVideosInput.checked
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
            downloadVideos,
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

    // In full library view, hide product rows that have no images for the selected media types.
    let renderableProducts = products;
    const _showingAllTypes = _allMediaTypes.every((t) =>
        activeMediaTypes.has(t),
    );
    if (containerId === "fullLibraryArea" && !_showingAllTypes) {
        renderableProducts = products.filter((prod) => {
            const groups = getDisplayLayout(prod);
            return [...activeMediaTypes].some(
                (t) => (groups[t] || []).length > 0,
            );
        });
    }

    if (renderableProducts.length === 0) {
        const _typeLabel = [...activeMediaTypes].join(", ");
        container.innerHTML += `<div style="padding:20px; text-align:center; color:#666; background:white; border:1px solid #ddd;">No products contain ${_typeLabel} images.</div>`;
        updateReorderBar();
        updateRemovalBar();
        return;
    }

    // Limit for performance
    const limit = showAll ? renderableProducts.length : 50;
    const productsToRender = renderableProducts.slice(0, limit);

    if (renderableProducts.length > limit) {
        const warning = document.createElement("div");
        warning.style.cssText =
            "padding:10px; background:#fff3cd; color:#856404; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;";
        warning.innerHTML = `
            <span>Showing first ${limit} of ${renderableProducts.length} products for performance.</span>
            <button id="btnLoadAll-${containerId}" style="padding:5px 10px; font-size:12px; background:#856404; color:white; border:none; border-radius:4px; cursor:pointer;">Load All (${renderableProducts.length})</button>
        `;
        container.appendChild(warning);

        // Use timeout to attach event after DOM insertion
        setTimeout(() => {
            const btn = document.getElementById(`btnLoadAll-${containerId}`);
            if (btn) {
                btn.onclick = () =>
                    renderGallery(renderableProducts, containerId, true);
            }
        }, 0);
    } else if (showAll && renderableProducts.length > 50) {
        container.innerHTML += `<div style="padding:10px; background:#d4edda; color:#155724; margin-bottom:10px;">Showing all ${renderableProducts.length} products. This may affect performance.</div>`;
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

            // Push Plus toggle button
            const pushPlusBtn = document.createElement("button");
            pushPlusBtn.type = "button";
            pushPlusBtn.className = "product-push-plus-btn";
            const existingPlusCount = (() => {
                const l = getDisplayLayout(prod);
                return l.plus ? l.plus.length : 0;
            })();
            pushPlusBtn.textContent =
                existingPlusCount > 0
                    ? `📤 Plus (${existingPlusCount})`
                    : "📤 Push Plus";
            pushPlusBtn.title =
                existingPlusCount > 0
                    ? `Append to ${existingPlusCount} existing plus image(s)`
                    : "Select images to push as plus content";
            headerActions.appendChild(pushPlusBtn);

            header.appendChild(headerActions);

            row.appendChild(header);

            // Numpad sidebar
            const numpad = document.createElement("div");
            numpad.className = "product-numpad";

            const numpadLabel = document.createElement("div");
            numpadLabel.className = "numpad-label";
            numpadLabel.textContent = "Select #";
            numpad.appendChild(numpadLabel);

            const numpadGrid = document.createElement("div");
            numpadGrid.className = "numpad-grid";

            if (!productNumpadSelections[prod.handle]) {
                productNumpadSelections[prod.handle] = new Set();
            }
            const sel = productNumpadSelections[prod.handle];

            for (let n = 0; n <= 11; n++) {
                const nb = document.createElement("button");
                nb.type = "button";
                nb.className = "numpad-btn" + (sel.has(n) ? " selected" : "");
                nb.textContent = String(n);
                nb.addEventListener("click", () => {
                    if (sel.has(n)) {
                        sel.delete(n);
                        nb.classList.remove("selected");
                    } else {
                        sel.add(n);
                        nb.classList.add("selected");
                    }
                    _saveNumpadSelections();
                });
                numpadGrid.appendChild(nb);
            }
            numpad.appendChild(numpadGrid);

            const clearBtn = document.createElement("button");
            clearBtn.type = "button";
            clearBtn.className = "numpad-clear-btn";
            clearBtn.textContent = "Clear";
            clearBtn.addEventListener("click", () => {
                sel.clear();
                numpadGrid
                    .querySelectorAll(".numpad-btn")
                    .forEach((b) => b.classList.remove("selected"));
                _saveNumpadSelections();
            });
            numpad.appendChild(clearBtn);

            // Wrap content + numpad in a flex row
            const cardBody = document.createElement("div");
            cardBody.style.cssText =
                "display:flex; align-items:flex-start; gap:0;";

            // Media Grid
            const grid = document.createElement("div");
            grid.style.cssText =
                "display:flex; flex-direction:column; gap:15px; flex:1; min-width:0;";
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
                        plus: [...(baseLayout.plus || [])],
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
                    const hintText =
                        groupName === "plus"
                            ? "drag to reorder · drop from other sections to add (copy)"
                            : "drag to reorder or move";
                    const hint = isDraggable
                        ? ` <span style="font-size:10px;color:#aaa;font-weight:400;margin-left:4px;">${hintText}</span>`
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

                            // Prevent any plus-section items from being dragged into other groups
                            const srcGroupEl = _dnd.srcEl.parentElement;
                            const srcGroup =
                                srcGroupEl?.dataset?.dndGroup || "";
                            if (srcGroup === "plus" && groupName !== "plus") {
                                alert(
                                    "Plus images cannot be moved to other groups directly. Use the Push Plus panel to manage them.",
                                );
                                return;
                            }

                            // When dragging from another group INTO plus, clone the card
                            // so the original remains in its group (additive semantics)
                            const isCrossGroupIntoPlusDrop =
                                groupName === "plus" && srcGroup !== "plus";
                            let cardToInsert = _dnd.srcEl;
                            if (isCrossGroupIntoPlusDrop) {
                                // Check for duplicate: don't allow the same layoutKey twice in plus
                                const existingKeys = new Set(
                                    [
                                        ...rowDiv.querySelectorAll(".dnd-card"),
                                    ].map((c) => c.dataset.layoutKey),
                                );
                                if (
                                    existingKeys.has(
                                        _dnd.srcEl.dataset.layoutKey,
                                    )
                                ) {
                                    // Already in plus — nothing to do
                                    return;
                                }
                                cardToInsert = _dnd.srcEl.cloneNode(true);
                                // Re-attach drag events to the clone so it can be reordered within plus
                                cardToInsert.addEventListener(
                                    "dragstart",
                                    (ev) => {
                                        if (
                                            deleteMode ||
                                            Object.keys(pendingRemovals)
                                                .length > 0
                                        ) {
                                            ev.preventDefault();
                                            return;
                                        }
                                        _dnd.srcEl = cardToInsert;
                                        _dnd.srcHandle = prod.handle;
                                        ev.dataTransfer.effectAllowed = "move";
                                        setTimeout(() => {
                                            cardToInsert.style.opacity = "0.4";
                                        }, 0);
                                    },
                                );
                                cardToInsert.addEventListener("dragend", () => {
                                    cardToInsert.style.opacity = "1";
                                    _dnd.srcEl = null;
                                    _dnd.srcHandle = null;
                                    clearDropMarkers();
                                });
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
                                dst !== cardToInsert &&
                                rowDiv.contains(dst)
                            ) {
                                const srcIdx = [...rowDiv.children].indexOf(
                                    cardToInsert,
                                );
                                const dstIdx = [...rowDiv.children].indexOf(
                                    dst,
                                );
                                if (srcIdx < dstIdx) {
                                    rowDiv.insertBefore(
                                        cardToInsert,
                                        dst.nextSibling,
                                    );
                                } else {
                                    rowDiv.insertBefore(cardToInsert, dst);
                                }
                            } else {
                                rowDiv.appendChild(cardToInsert);
                            }

                            syncPendingLayout();
                        });
                    }

                    items.forEach((m) => {
                        const card = document.createElement("div");
                        card.style.cssText =
                            "width:100px; height:100px; border:1px solid #ddd; border-radius:4px; overflow:hidden; position:relative; background:#f0f0f0;";
                        card.classList.add("media-card");

                        const remoteBindingId =
                            m.shopifyFileId || m.shopifyId || "";
                        const isSyntheticPlusAsset =
                            String(remoteBindingId).startsWith("meta-json:");

                        const canDragItem =
                            isDraggable &&
                            canDnd &&
                            m.type === "image" &&
                            (!!remoteBindingId || isSyntheticPlusAsset);
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
                            ((!isSyntheticPlusAsset && !!remoteBindingId) ||
                                isSyntheticPlusAsset);
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

                // Order: Main, Banner, Extra, Plus, Other
                // Render only sections whose type is in the active multi-select set
                const _showAll = _allMediaTypes.every((t) =>
                    activeMediaTypes.has(t),
                );
                if (_showAll || activeMediaTypes.has("main"))
                    renderSection("main", "Main Images", groups.main, true);
                if (_showAll || activeMediaTypes.has("banner"))
                    renderSection("banner", "Banners", groups.banner, true);
                if (_showAll || activeMediaTypes.has("extra"))
                    renderSection("extra", "Extras", groups.extra, true);
                if (_showAll || activeMediaTypes.has("plus"))
                    renderSection("plus", "Plus", groups.plus, true);
                if (_showAll) renderSection("other", "Other", groups.other);

                // grid is populated by renderSection (which appends to mainWrapper which is grid)
            } else {
                grid.innerHTML =
                    '<div style="color:#999; padding:10px;">No media files in this product folder.</div>';
            }

            cardBody.appendChild(grid);
            cardBody.appendChild(numpad);
            row.appendChild(cardBody);

            // Inline Push Plus panel
            const ppPanel = document.createElement("div");
            ppPanel.className = "lib-pp-panel";

            pushPlusBtn.addEventListener("click", () => {
                const isOpen = ppPanel.classList.toggle("open");
                pushPlusBtn.classList.toggle("active", isOpen);
                if (isOpen && ppPanel.children.length === 0) {
                    _buildLibPushPlusPanel(ppPanel, prod);
                }
            });

            row.appendChild(ppPanel);
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

        // If user pastes multi-line content, auto-switch to List Search mode
        searchInput.addEventListener("paste", (e) => {
            const text = (e.clipboardData || window.clipboardData).getData(
                "text",
            );
            if (!text.includes("\n")) return;
            e.preventDefault();
            // Switch to multi-search mode if not already active
            const panel = document.getElementById("multiSearchPanel");
            if (panel && panel.style.display === "none") {
                toggleMultiSearch();
            }
            const ta = document.getElementById("libMultiSearch");
            if (ta) {
                ta.value = text.trim();
                ta.focus();
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

// ============ BULK RENAME PLUS IMAGES ============

let _plusRenameItems = []; // resolved items from prepare step
let _plusRenameProductMeta = {}; // per-product metafield info for post-rename patching

async function showPlusRenameModal() {
    const shopUrl = localStorage.getItem("lastShop") || "";
    const apiKey = localStorage.getItem("lastKey") || "";
    const metafieldKeys = localStorage.getItem("lastMetafields") || "";
    const folderPath = selectedPath;

    if (!shopUrl || !apiKey) {
        alert(
            "Please enter your Shopify URL and API key in the Sync tab first.",
        );
        return;
    }
    if (!folderPath) {
        alert("Please select a download folder in the Sync tab first.");
        return;
    }

    const modal = document.getElementById("plusRenameModal");
    const subtitle = document.getElementById("plusRenameSubtitle");
    const warning = document.getElementById("plusRenameWarning");
    const tbody = document.getElementById("plusRenameTableBody");
    const status = document.getElementById("plusRenameStatus");
    const confirmBtn = document.getElementById("plusRenameConfirmBtn");

    // Reset state
    _plusRenameItems = [];
    tbody.innerHTML = "";
    warning.style.display = "none";
    confirmBtn.disabled = true;
    subtitle.textContent = "Scanning manifest and resolving Shopify file IDs…";
    status.textContent = "";

    modal.style.display = "flex";

    try {
        const result = await ipcRenderer.invoke("prepare-plus-rename", {
            shopUrl,
            apiKey,
            metafieldKeys,
            folderPath,
        });

        if (result.error) {
            subtitle.textContent = "Configuration error:";
            status.textContent = result.error;
            status.style.color = "#c62828";
            return;
        }

        const items = result.items || [];
        const unresolvedCount = result.unresolvedCount || 0;

        if (items.length === 0) {
            subtitle.textContent = "No plus images found in the manifest.";
            status.textContent =
                "Sync first so plus images appear in the manifest.";
            return;
        }

        const resolvedCount = items.filter((i) => i.resolved).length;
        subtitle.textContent = `${items.length} image(s) across ${new Set(items.map((i) => i.handle)).size} product(s) — ${resolvedCount} resolved, ${unresolvedCount} unresolved (will be skipped).`;

        if (unresolvedCount > 0) {
            warning.style.display = "block";
            warning.textContent = `⚠ ${unresolvedCount} image(s) could not be matched to a Shopify file ID and will be skipped. Sync again to refresh CDN URLs, then retry.`;
        }

        // Build table rows
        items.forEach((item) => {
            const tr = document.createElement("tr");
            tr.style.borderBottom = "1px solid #f0f0f0";
            if (!item.resolved) tr.style.opacity = "0.45";

            const statusIcon = item.resolved ? "✓" : "⚠";
            const statusColor = item.resolved ? "#2e7d32" : "#e65100";

            tr.innerHTML = `
                <td style="padding:5px 10px; font-family: monospace; font-size:0.95em">${escHtml(item.handle)}</td>
                <td style="padding:5px 10px; text-align:center">${item.order}</td>
                <td style="padding:5px 10px; color:#777; word-break:break-all">${escHtml(item.currentFilename)}</td>
                <td style="padding:5px 10px; font-weight:600; word-break:break-all">${escHtml(item.newFilename)}</td>
                <td style="padding:5px 10px; color:#444; font-style:italic; word-break:break-all">${escHtml(item.newAlt)}</td>
                <td style="padding:5px 6px; text-align:center; color:${statusColor}; font-weight:700">${statusIcon}</td>
            `;
            tbody.appendChild(tr);
        });

        _plusRenameItems = items;
        _plusRenameProductMeta = result.productMeta || {};
        confirmBtn.disabled = resolvedCount === 0;
        status.textContent =
            resolvedCount > 0
                ? `Ready to rename ${resolvedCount} file(s).`
                : "No resolvable files found.";
        status.style.color = resolvedCount > 0 ? "#1b5e20" : "#c62828";
    } catch (err) {
        subtitle.textContent = "Failed to prepare rename plan.";
        status.textContent = err.message;
        status.style.color = "#c62828";
    }
}

function closePlusRenameModal() {
    const modal = document.getElementById("plusRenameModal");
    modal.style.display = "none";
    _plusRenameItems = [];
    _plusRenameProductMeta = {};
    const log = document.getElementById("plusRenameLog");
    if (log) {
        log.style.display = "none";
        log.textContent = "";
    }
}

async function confirmPlusRename() {
    const shopUrl = localStorage.getItem("lastShop") || "";
    const apiKey = localStorage.getItem("lastKey") || "";
    const status = document.getElementById("plusRenameStatus");
    const confirmBtn = document.getElementById("plusRenameConfirmBtn");
    const cancelBtn = document.getElementById("plusRenameCancelBtn");

    const toRename = _plusRenameItems.filter((i) => i.resolved);
    if (toRename.length === 0) return;
    const gidToItem = new Map(toRename.map((i) => [i.gid, i]));

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    status.textContent = `Renaming ${toRename.length} file(s)…`;
    status.style.color = "#555";

    const resultLogEl = document.getElementById("plusRenameLog");
    if (resultLogEl) {
        resultLogEl.style.display = "none";
        resultLogEl.textContent = "";
    }

    try {
        const result = await ipcRenderer.invoke("execute-plus-rename", {
            shopUrl,
            apiKey,
            updates: toRename,
            productMeta: _plusRenameProductMeta,
        });

        const s = result.succeeded?.length || 0;
        const f = result.failed?.length || 0;
        const patched = result.metafieldsPatchedCount || 0;
        const patchNote =
            patched > 0 ? ` Metafields updated for ${patched} product(s).` : "";

        // Build precise log lines for UI display
        const logLines = [];
        if (result.failed?.length) {
            for (const fail of result.failed) {
                const item = gidToItem.get(fail.id);
                const label = item
                    ? `${item.currentFilename} → ${item.newFilename}`
                    : fail.id || "unknown";
                const codePrefix = fail.code ? `${fail.code} — ` : "";
                logLines.push(`❌ ${label}: ${codePrefix}${fail.error}`);
            }
        }
        if (result.metafieldsPatchError) {
            logLines.push(`⚠ Metafield patch: ${result.metafieldsPatchError}`);
        }
        if (resultLogEl && logLines.length > 0) {
            resultLogEl.textContent = logLines.join("\n");
            resultLogEl.style.display = "block";
        }

        if (f === 0 && !result.metafieldsPatchError) {
            status.textContent = `✓ Done — ${s} file(s) renamed successfully.${patchNote}`;
            status.style.color = "#1b5e20";
        } else if (f === 0) {
            status.textContent = `⚠ Renames done (${s}), but metafield patch failed. See log below.`;
            status.style.color = "#e65100";
        } else {
            status.textContent = `⚠ Completed: ${s} renamed, ${f} failed.${patchNote} See log below.`;
            status.style.color = "#e65100";
        }

        _plusRenameItems = [];
        confirmBtn.textContent = "Done";
        confirmBtn.disabled = false;
        confirmBtn.onclick = closePlusRenameModal;
        cancelBtn.disabled = false;
    } catch (err) {
        status.textContent = `Error: ${err.message}`;
        status.style.color = "#c62828";
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
    }
}

function escHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function patchPlusMetafields() {
    const shopUrl = localStorage.getItem("lastShop") || "";
    const apiKey = localStorage.getItem("lastKey") || "";
    const metafieldKeys = localStorage.getItem("lastMetafields") || "";
    const folderPath = selectedPath;

    if (!shopUrl || !apiKey) {
        alert(
            "Please enter your Shopify URL and API key in the Sync tab first.",
        );
        return;
    }
    if (!folderPath) {
        alert("Please select a download folder in the Sync tab first.");
        return;
    }

    const btn = document.getElementById("floatPatchPlusBtn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Patching\u2026";

    try {
        const result = await ipcRenderer.invoke("patch-plus-metafields", {
            shopUrl,
            apiKey,
            metafieldKeys,
            folderPath,
        });

        const summary = [
            `\u2713 Patched: ${result.patched} product(s)`,
            result.skipped > 0
                ? `\u26a0 Skipped: ${result.skipped} (new filenames not yet on Shopify \u2014 sync first?)`
                : null,
            result.failed > 0 ? `\u2717 Failed: ${result.failed}` : null,
        ]
            .filter(Boolean)
            .join("  |  ");

        const logModal = document.getElementById("patchPlusLogModal");
        document.getElementById("patchPlusLogSummary").textContent = summary;
        document.getElementById("patchPlusLogText").value =
            (result.logs || []).join("\n") || "(no log output)";
        logModal.style.display = "flex";
    } catch (err) {
        alert(`Patch failed: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}
