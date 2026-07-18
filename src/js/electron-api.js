// Front-end bootstrap. Bridges the preload `window.api` to the app.
// `api` stays available as the global window.api — the Electron contextBridge
// boundary is legitimately global — so only `dialog` needs an export.
export const dialog = { open: (options) => window.api.openDialog(options) };

// window.app is the single remaining global: a minimal bridge to the separately
// bundled markdown-preview.js, which reads window.app.currentOpenFile (mirrored
// from editorState) and window.app.openExternalLink (set in app.js). All real
// application state lives in the state/ modules.
window.app = window.app || {};

// NOTE: the vault-change -> refreshFileTree wiring moved to app.js so this
// bootstrap stays a dependency-free leaf (it would otherwise import file-tree).
