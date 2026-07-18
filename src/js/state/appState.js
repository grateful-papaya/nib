// js/state/appState.js
// App-session level: the active vault (workspace) path and background timers.
// vaultPath lives here rather than in editorState because it is read almost
// everywhere (tree, sidebar, settings, editor) and outlives any single file.
// Was: window.app.currentVaultPath, window.app.cloudBackupInterval

let vaultPath = null;
let cloudBackupInterval = null;

export const getVaultPath = () => vaultPath;
export function setVaultPath(p) {
  vaultPath = p;
}

export const getCloudBackupInterval = () => cloudBackupInterval;
export function setCloudBackupInterval(id) {
  cloudBackupInterval = id;
}
