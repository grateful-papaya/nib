// ─── Sidebar view switching: file tree ⇄ document outline ────────────────────
//
// The sidebar hosts two stacked layers:
//   base layer — the file-tree content (action group, tree, search results,
//                footer)
//   top layer  — the outline panel (.sidebar-toc-panel), absolutely positioned
//                over the tree and slid in/out via transform. Its contents are
//                toc.js's business; this file only decides when it's shown.
//
// The menu button cycles closed → tree → toc → closed on click, and the reverse
// on right-click; hovering it briefly opens a popup for picking a view directly.
// Switching panels animates only the top panel's transform; opening and
// collapsing keep the width animation, with the transform snapped.

import { setSidebarOpen, getSidebarWidth } from "./state/uiState.js";
import { refreshToc } from "./toc.js";

// ─── 1. Menu-button hover popup ──────────────────────────────────────────────
const MenuPopup = (() => {
  const SHOW_DELAY_MS = 450; // "hover briefly" before the popup appears
  const HIDE_DELAY_MS = 250; // grace period to travel from button to popup

  let showTimer = null;
  let hideTimer = null;

  const getPopup = () => document.getElementById("menu-popup");
  const getButton = () => document.getElementById("menu-btn");

  const clearTimers = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = hideTimer = null;
  };

  const show = () => {
    const popup = getPopup();
    const btn = getButton();
    if (!popup || !btn) return;

    const rect = btn.getBoundingClientRect();
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.top = `${rect.bottom + 6}px`;
    popup.classList.add("show");
  };

  const hide = () => {
    clearTimers();
    getPopup()?.classList.remove("show");
  };

  const scheduleShow = () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (showTimer) return;
    showTimer = setTimeout(() => {
      showTimer = null;
      show();
    }, SHOW_DELAY_MS);
  };

  const scheduleHide = () => {
    clearTimers();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      getPopup()?.classList.remove("show");
    }, HIDE_DELAY_MS);
  };

  const syncActive = (view) => {
    document
      .getElementById("menu-popup-tree")
      ?.classList.toggle("active", view === "tree");
    document
      .getElementById("menu-popup-toc")
      ?.classList.toggle("active", view === "toc");
  };

  const init = (onPick) => {
    const popup = getPopup();
    const btn = getButton();
    if (!popup || !btn) return;

    btn.addEventListener("mouseenter", scheduleShow);
    btn.addEventListener("mouseleave", scheduleHide);

    popup.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
      hideTimer = null;
    });
    popup.addEventListener("mouseleave", scheduleHide);

    popup.querySelectorAll(".menu-popup-item").forEach((item) => {
      item.addEventListener("click", () => {
        hide();
        onPick(item.getAttribute("data-view"));
      });
    });

    window.addEventListener("blur", hide);
  };

  return { init, hide, syncActive };
})();

// ─── 2. View state machine ───────────────────────────────────────────────────

const VIEWS = ["closed", "tree", "toc"];
const FALLBACK_WIDTH = "200px";

const KEYS = {
  view: "vault_sidebar_view",
  open: "vault_sidebar_open",
  width: "vault_sidebar_width",
};

let currentView = "closed";

const setCssWidth = (w) =>
  document.documentElement.style.setProperty("--sidebar-width", w);

const applyOpenWidth = () => {
  const w = getSidebarWidth() || localStorage.getItem(KEYS.width);
  setCssWidth(w && w !== "0px" ? w : FALLBACK_WIDTH);
};

// Run `mutate` with the panel's transition suppressed, so a class change lands
// instantly instead of sliding.
const snapPanel = (mutate) => {
  const panel = document.getElementById("sidebar-toc-panel");
  if (!panel) return mutate();
  panel.style.transition = "none";
  mutate();
  void panel.offsetWidth; // commit the no-transition state
  panel.style.transition = "";
};

export function setSidebarView(next, { animate = true } = {}) {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || !VIEWS.includes(next) || next === currentView) return;

  const prev = currentView;
  currentView = next;

  const wasOpen = prev !== "closed";
  const isOpen = next !== "closed";

  if (isOpen) {
    const mutate = () => sidebar.classList.toggle("toc-open", next === "toc");
    // tree ⇄ toc gets the overlay slide; opening from closed does not.
    if (animate && wasOpen) mutate();
    else snapPanel(mutate);
  }

  if (isOpen && !wasOpen) {
    sidebar.classList.add("open");
    applyOpenWidth();
  } else if (!isOpen && wasOpen) {
    sidebar.classList.remove("open");
    setCssWidth("0px");
  }

  setSidebarOpen(isOpen);
  localStorage.setItem(KEYS.view, next);
  localStorage.setItem(KEYS.open, String(isOpen));

  if (next === "toc") refreshToc(); // never show a stale outline
  MenuPopup.syncActive(next);
}

const cycle = (dir) => {
  const i = VIEWS.indexOf(currentView);
  setSidebarView(VIEWS[(i + dir + VIEWS.length) % VIEWS.length]);
};

const restoreInitialView = () => {
  const sidebar = document.getElementById("sidebar");
  const savedOpen = localStorage.getItem(KEYS.open);
  const savedView = localStorage.getItem(KEYS.view);
  const savedWidth = localStorage.getItem(KEYS.width);

  if (savedWidth) setCssWidth(savedWidth);

  const initial =
    savedOpen === "false" ? "closed" : savedView === "toc" ? "toc" : "tree";

  if (sidebar) {
    sidebar.style.transition = "none";
    snapPanel(() => {
      sidebar.classList.toggle("open", initial !== "closed");
      sidebar.classList.toggle("toc-open", initial === "toc");
    });
    if (initial === "closed") setCssWidth("0px");
    void sidebar.offsetWidth;
    sidebar.style.transition = "";
  }

  currentView = initial;
  setSidebarOpen(initial !== "closed");
  if (initial === "toc") refreshToc();
  MenuPopup.syncActive(initial);
};

export function initSidebarViews() {
  MenuPopup.init(setSidebarView);

  const menuBtn = document.getElementById("menu-btn");
  menuBtn?.addEventListener("click", () => {
    MenuPopup.hide();
    cycle(1);
  });
  menuBtn?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    MenuPopup.hide();
    cycle(-1);
  });

  restoreInitialView();
}
