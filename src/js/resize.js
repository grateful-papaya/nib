import {
  getSidebarWidth,
  setSidebarWidth,
  setSidebarOpen,
} from "./state/uiState.js";

/**
 * Initialize the sidebar width resize drag.
 *
 * Dragging far enough toward the edge collapses the sidebar instantly; dragging
 * back out past the expand threshold restores it.
 */
export function initSidebarResizer() {
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebar-resizer");
  if (!sidebar || !resizer) return;

  let isResizing = false;
  const minWidth = 150;

  // Remembers the last expanded (non-collapsed) width so it can be restored
  // when the sidebar is reopened, instead of always snapping to minWidth.
  // Seeded from uiState so a prior session's width carries over.
  let lastExpandedWidth = parseInt(getSidebarWidth(), 10) || minWidth;
  if (lastExpandedWidth < minWidth) lastExpandedWidth = minWidth;

  // Begin dragging on mousedown over the resizer bar.
  resizer.addEventListener("mousedown", (e) => {
    isResizing = true;
    sidebar.classList.add("resizing"); // disable width transition while dragging
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  // Track width and collapse/expand state on mouse move.
  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;

    let newWidth = e.clientX;
    const collapseThreshold = minWidth * 0.3; // below this (45px): collapse
    const expandThreshold = minWidth * 0.7; // above this (105px): re-expand

    // Read the live width to determine whether we are currently collapsed.
    const currentWidthStyle = document.documentElement.style
      .getPropertyValue("--sidebar-width")
      .trim();
    const isCollapsed = currentWidthStyle === "0px";

    if (isCollapsed) {
      // Collapsed: the user is dragging right to expand again.
      if (newWidth >= expandThreshold) {
        if (newWidth < minWidth) newWidth = minWidth;
        document.documentElement.style.setProperty(
          "--sidebar-width",
          `${newWidth}px`,
        );
      } else {
        // Stay collapsed until the expand threshold is crossed.
        document.documentElement.style.setProperty("--sidebar-width", "0px");
      }
    } else {
      // Expanded: the user is dragging left to shrink.
      if (newWidth <= collapseThreshold) {
        // Drop straight to 0px (no animation) once inside the collapse zone.
        document.documentElement.style.setProperty("--sidebar-width", "0px");
      } else {
        // Otherwise track the cursor while enforcing the 150px minimum.
        if (newWidth < minWidth) newWidth = minWidth;
        document.documentElement.style.setProperty(
          "--sidebar-width",
          `${newWidth}px`,
        );
      }
    }
  });

  // Finalize the drag and restore guards on mouse up.
  document.addEventListener("mouseup", () => {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove("resizing");
    document.body.style.cursor = "";

    const currentWidth = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar-width")
      .trim();

    if (currentWidth === "0px") {
      sidebar.classList.remove("open");
      setSidebarOpen(false);
    } else {
      sidebar.classList.add("open");
      setSidebarOpen(true);
      // Confirm the drag result: this is the single point where the final
      // width is committed as the value to restore next time the sidebar opens.
      lastExpandedWidth = parseInt(currentWidth, 10) || lastExpandedWidth;
      setSidebarWidth(`${lastExpandedWidth}px`);
    }
  });

  // The outline↕references split shares one drag loop with the width resizer,
  // so grabbing the corner where they meet can move both at once.
  initTocSplitResizer();
}

// ─── Outline ↕ References split ───────────────────────────────────────────────
//
// `--toc-split` is the OUTLINE (top) section's height as a % of the panel;
// References takes the remainder. The horizontal bar (#toc-vsplit) drags it;
// the corner (#toc-vsplit-corner) sits over the sidebar's right edge and drags
// BOTH the split ratio (Y) and the sidebar width (X) simultaneously — the
// "겹치는 부분" the request asks to resize together.
const SPLIT_KEY = "vault_toc_split";
const MIN_SPLIT = 20; // never shrink either section below 20% of the panel
const MAX_SPLIT = 80;
const MIN_SIDEBAR = 150;

function clampSplit(pct) {
  return Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, pct));
}

function applyStoredSplit() {
  const saved = parseFloat(localStorage.getItem(SPLIT_KEY));
  const pct = Number.isFinite(saved) ? clampSplit(saved) : 58; // "절반 좀 넘게"
  document.documentElement.style.setProperty("--toc-split", `${pct}%`);
}

export function initTocSplitResizer() {
  const panel = document.getElementById("sidebar-toc-panel");
  const vsplit = document.getElementById("toc-vsplit");
  const corner = document.getElementById("toc-vsplit-corner");
  if (!panel) return;

  applyStoredSplit();

  const setSplitFromY = (clientY) => {
    const rect = panel.getBoundingClientRect();
    if (rect.height <= 0) return;
    const pct = clampSplit(((clientY - rect.top) / rect.height) * 100);
    document.documentElement.style.setProperty("--toc-split", `${pct}%`);
  };

  const setWidthFromX = (clientX) => {
    let w = clientX;
    const maxW = window.innerWidth * 0.5; // matches .sidebar max-width: 50vw
    if (w < MIN_SIDEBAR) w = MIN_SIDEBAR;
    if (w > maxW) w = maxW;
    document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
  };

  let mode = null; // "split" | "both"

  const onMove = (e) => {
    if (!mode) return;
    setSplitFromY(e.clientY);
    if (mode === "both") setWidthFromX(e.clientX);
    e.preventDefault();
  };

  const onUp = () => {
    if (!mode) return;
    mode = null;
    panel.classList.remove("splitting");
    document.getElementById("sidebar")?.classList.remove("resizing");
    document.body.style.cursor = "";

    const split = getComputedStyle(document.documentElement)
      .getPropertyValue("--toc-split")
      .trim();
    if (split) localStorage.setItem(SPLIT_KEY, split);

    const width = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar-width")
      .trim();
    if (width && width !== "0px") {
      setSidebarWidth(width);
    }
  };

  const startDrag = (which, e) => {
    mode = which;
    panel.classList.add("splitting");
    // Reuse the sidebar's "resizing" guard so its width transition is off and
    // the width-resizer guide styling shows while dragging the corner.
    if (which === "both") {
      document.getElementById("sidebar")?.classList.add("resizing");
    }
    document.body.style.cursor = which === "both" ? "nwse-resize" : "row-resize";
    e.preventDefault();
    e.stopPropagation();
  };

  vsplit?.addEventListener("mousedown", (e) => {
    // The corner is a child of the bar; let it own its own mousedown.
    if (corner && corner.contains(e.target)) return;
    startDrag("split", e);
  });
  corner?.addEventListener("mousedown", (e) => startDrag("both", e));

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
