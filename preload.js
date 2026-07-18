const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");
const backend = require("./rust-backend/index.js");

// The addon is loaded separately in this process, so main.js setting
// SEVENZIP_PATH doesn't reach it -- and backupOnQuit() is called from here,
// not from main. Set the same value again. (Keep in sync with main.js's
// sevenzipPath(); the Rust side has matching per-platform fallbacks too.)
function sevenzipPath() {
  const dir = path.join(__dirname, "bin");
  if (process.platform === "win32") {
    return path.join(dir, "7zzs-x86_64-pc-windows-msvc.exe");
  }
  if (process.platform === "darwin") {
    return path.join(dir, "7zzs-aarch64-apple-darwin");
  }
  return path.join(dir, "7zzs-x86_64-unknown-linux-gnu");
}
process.env.SEVENZIP_PATH = sevenzipPath();

// ── Field-name translation (napi camelCases struct fields) ──────────────────
// napi gives FileNode.isDir / AppSettings.fontFamily; the app was written
// against snake_case. Translate only where structs cross the boundary.
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function camelToSnake(s) {
  return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}
function convertKeys(obj, fn) {
  if (Array.isArray(obj)) return obj.map((v) => convertKeys(v, fn));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[fn(k)] = convertKeys(v, fn);
    return out;
  }
  return obj;
}
function fixFileNode(node) {
  if (!node) return node;
  return {
    name: node.name,
    path: node.path,
    is_dir: node.isDir,
    size: node.size,
    children: node.children ? node.children.map(fixFileNode) : null,
  };
}

// Native watcher hits arrive from main as "vault-changed"; fan out to handlers.
const vaultChangeHandlers = [];
ipcRenderer.on("vault-changed", () => {
  for (const h of vaultChangeHandlers) {
    try {
      h();
    } catch (_) {}
  }
});

// Window state pushes from main. Subscribing starts here in the preload (which
// runs before any page script) and the last value is buffered, so a push that
// lands before app.js registers its handler is replayed instead of lost.
function makeStateChannel(channel) {
  const handlers = [];
  let last = null; // null = no push received yet
  ipcRenderer.on(channel, (_e, value) => {
    last = value;
    for (const h of handlers) {
      try {
        h(value);
      } catch (_) {}
    }
  });
  return (handler) => {
    handlers.push(handler);
    if (last !== null) {
      try {
        handler(last);
      } catch (_) {}
    }
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  };
}
const subscribeWindowFocus = makeStateChannel("window-focus-changed");
const subscribeWindowSquared = makeStateChannel("window-squared-changed");

// ── Native API (camelCase, named-arg objects) ───────────────────────────────
// Each fn takes the same { ... } object the call sites already pass, so the
// migration is a mechanical rename: invoke("get_file_tree", a) -> api.getFileTree(a).
const api = {
  // ── Vault location ───────────────────────────────────────────────────────
  // createVaultDirectory uses the default spot (<Documents>/Markdown Vault)
  // and throws if it isn't writable; createVaultAt takes a folder the user
  // picked and uses it as the vault root directly; verifyVault re-checks a
  // remembered path on startup. All three probe writability before returning,
  // so a path that comes back is one that actually works.
  createVaultDirectory: () => backend.createVaultDirectory(),
  createVaultAt: ({ path: p }) => backend.createVaultAt(p),
  verifyVault: ({ path: p }) => backend.verifyVault(p),

  // Folder picker for the two cases above. Returns a path, or null if canceled.
  pickVaultFolder: () => ipcRenderer.invoke("pick-vault-folder"),

  // "win32" | "darwin" | "linux". The renderer needs this to decide whether
  // the default vault location is even worth attempting (see resolveVaultPath).
  platform: process.platform,

  getFileTree: async ({ vaultPath }) => {
    const r = await backend.getFileTree(vaultPath);
    return Array.isArray(r) ? r.map(fixFileNode) : r;
  },

  // Rust returns SearchMatch objects already camelCase (name, path, isDir,
  // matchStart, matchEnd, score) via napi, and the frontend reads them as
  // camelCase directly (see sidebar.js's search result rendering) — so
  // unlike getFileTree/loadSettings, no key translation is needed here.
  searchFileTree: ({ vaultPath, query }) =>
    backend.searchFileTree(vaultPath, query),

  // Same story as searchFileTree: ContentSearchMatch fields (path, name,
  // lineNumber, lineText, matchStart, matchLen) arrive already camelCase via
  // napi, and titlebar-search.js reads them as-is — no key translation.
  searchContentInVault: ({ vaultPath, query }) =>
    backend.searchContentInVault(vaultPath, query),

  readFileContent: ({ filePath }) => backend.readFileContent(filePath),

  writeFileContent: ({ vaultPath, filePath, content }) =>
    backend.writeFileContent(vaultPath, filePath, content),

  createNewFile: ({ parentPath, fileName }) =>
    backend.createNewFile(parentPath, fileName),

  createNewFolder: ({ parentPath, folderName }) =>
    backend.createNewFolder(parentPath, folderName),

  renameFileOrFolder: ({ oldPath, newPath }) =>
    backend.renameFileOrFolder(oldPath, newPath),

  // Duplicate next to the source; resolves to the new path (used by
  // sidebar.js to select the copy in the tree).
  copyFileOrFolder: ({ sourcePath }) => backend.copyFileOrFolder(sourcePath),

  deleteFileOrFolder: ({ targetPath }) =>
    backend.deleteFileOrFolder(targetPath),

  restoreFromTrash: ({ originalPath }) =>
    backend.restoreFromTrash(originalPath),

  loadSettings: async ({ vaultPath }) => {
    const r = await backend.loadSettings(vaultPath);
    return convertKeys(r, camelToSnake);
  },

  saveSettings: ({ vaultPath, settings }) =>
    backend.saveSettings(vaultPath, convertKeys(settings, snakeToCamel)),

  // ── Backup (offline 7-Zip) ───────────────────────────────────────────────
  // Quit-time only: updates .backup/vault_archive.7z in place (7z `u` touches
  // just the entries whose files changed) and applies the snapshot policy from
  // settings (backup_snapshot_mode / _days / _keep). Fully local -- no cloud,
  // no network. Await this before windowClose().
  backupOnQuit: ({ vaultPath }) => backend.backupOnQuit(vaultPath),

  // Restore. listBackupSnapshots resolves to [{ name, path, size, modified }]
  // newest-first; restoreSnapshot rolls every document back to that version
  // (the current state is snapshotted first, so a restore is always undoable).
  listBackupSnapshots: ({ vaultPath }) =>
    backend.listBackupSnapshots(vaultPath),
  restoreSnapshot: ({ vaultPath, snapshotPath }) =>
    backend.restoreSnapshot(vaultPath, snapshotPath),

  saveFontByPath: ({ sourcePath, fileName }) =>
    backend.saveFontByPath(sourcePath, fileName),

  getFileMeta: ({ filePath }) => backend.getFileMeta(filePath),

  readImageBase64: ({ filePath }) => backend.readImageBase64(filePath),

  openExternalUrl: ({ url }) => backend.openExternalUrl(url),

  showInFolder: ({ targetPath }) => backend.showInFolder(targetPath),

  jsLog: ({ msg }) => backend.jsLog(msg),

  // Local path -> URL for dynamic @font-face (Electron loads file:// directly).
  convertFileSrc: (filePath) => "file://" + filePath,

  // File-open dialog. Returns a single path string, or null if canceled.
  openDialog: (options) => ipcRenderer.invoke("dialog-open", options),

  // Window controls (custom titlebar; frame:false).
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowClose: () => ipcRenderer.send("window-close"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  windowToggleMaximize: () => ipcRenderer.send("window-toggle-maximize"),
  // Tells main the drag-region titlebar is pressed/released, so main can
  // force rounded corners for the duration (see main.js setTitlebarPressed).
  titlebarPressed: (pressed) => ipcRenderer.send("titlebar-pressed", pressed),

  // Window state (pushed from main; see makeStateChannel above).
  onWindowFocusChange: (handler) => subscribeWindowFocus(handler),
  onWindowSquaredChange: (handler) => subscribeWindowSquared(handler),

  // File watcher.
  startVaultWatcher: (vaultPath) =>
    ipcRenderer.send("start-vault-watcher", vaultPath),
  onVaultChange: (handler) => {
    vaultChangeHandlers.push(handler);
    return () => {
      const i = vaultChangeHandlers.indexOf(handler);
      if (i >= 0) vaultChangeHandlers.splice(i, 1);
    };
  },
};

contextBridge.exposeInMainWorld("api", api);
