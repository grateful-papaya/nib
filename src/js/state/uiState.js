// state/uiState.js
// Transient UI state: sidebar open/width, the context-menu target, and the
// custom scrollbar drag flag.
// Was: window.app.state.ui.* , window.app.scrollbarDragging
// (Tree-selection DOM caches live in file-tree.js — used only there.)

let sidebarOpen = true;
let sidebarWidth = "250px";
let scrollbarDragging = false;
let settingsSliderDragging = false;

// Kept as one object so the sidebar can set .targetPath / .targetElement
// together via a live reference (getContextMenu().targetPath = ...).
const contextMenu = { targetPath: null, targetElement: null };

export const getSidebarOpen = () => sidebarOpen;
export function setSidebarOpen(v) {
  sidebarOpen = v;
}

export const getSidebarWidth = () => sidebarWidth;
export function setSidebarWidth(w) {
  sidebarWidth = w;
}

// True while the user is dragging an actual scrollbar thumb (any of them).
export const isScrollbarDragging = () => scrollbarDragging;
export function setScrollbarDragging(v) {
  scrollbarDragging = v;
}

// True while the user is dragging one of the settings-panel sliders
// (font size / line spacing / padding). Distinct from scrollbarDragging so
// grabbing a settings-panel scrollbar thumb doesn't get treated as a slider
// drag, and vice versa.
export const isSettingsSliderDragging = () => settingsSliderDragging;
export function setSettingsSliderDragging(v) {
  settingsSliderDragging = v;
}

export const getContextMenu = () => contextMenu;
