// state/uiState.js
// Transient UI state: sidebar open/width, the context-menu target, and the
// pointer-drag flags. Tree-selection DOM caches deliberately live in
// file-tree.js, since nothing outside that module reads them.

const DEFAULT_SIDEBAR_WIDTH = "250px";

const state = {
  sidebarOpen: true,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  // True while dragging an actual scrollbar thumb (any of them).
  scrollbarDragging: false,
  // True while dragging a settings-panel slider (font size / line spacing /
  // padding). Kept distinct from scrollbarDragging so grabbing a scrollbar
  // inside the settings panel isn't mistaken for a slider drag, or vice versa.
  settingsSliderDragging: false,
};

// One object, handed out by live reference, so the sidebar can set
// .targetPath / .targetElement together: getContextMenu().targetPath = ...
const contextMenu = { targetPath: null, targetElement: null };

export const getSidebarOpen = () => state.sidebarOpen;
export const setSidebarOpen = (v) => {
  state.sidebarOpen = !!v;
};

export const getSidebarWidth = () => state.sidebarWidth;
export const setSidebarWidth = (w) => {
  state.sidebarWidth = w || DEFAULT_SIDEBAR_WIDTH;
};

export const isScrollbarDragging = () => state.scrollbarDragging;
export const setScrollbarDragging = (v) => {
  state.scrollbarDragging = !!v;
};

export const isSettingsSliderDragging = () => state.settingsSliderDragging;
export const setSettingsSliderDragging = (v) => {
  state.settingsSliderDragging = !!v;
};

export const getContextMenu = () => contextMenu;
