// state/editorState.js
// Owns the live editor session: the CodeMirror view, which file is open,
// per-file scroll/cursor/reading-mode memory, and autosave plumbing.
//
// CONSOLIDATION NOTE
// Previously currentOpenFile / fileScrollPositions / fileCursorPositions each
// existed TWICE — once at window.app.* (written by file-tree.js) and once at
// window.app.state.editor.* (read/written by app.js). The rename handler
// operated on the state.editor copy while everything else used the top-level
// copy, so scroll/cursor migration on rename silently no-op'd. There is now
// exactly one of each, and setCurrentOpenFile() is the single choke point.

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let editorView = null;
let currentOpenFile = null;
let currentTitle = "";
let isSwitchingFile = false;
let autoSaveTimeout = null;
let triggerAutoSave = null;
let codeMirrorModules = null;
let currentPanzoom = null;

const fileScrollPositions = loadJSON("vault_file_scrolls");
const fileCursorPositions = loadJSON("vault_file_cursors");
const fileReadingModeStates = {};

// Flip to true to log every open-file change with a stack trace. This is the
// direct answer to "who changed this value and when?" — set it, reproduce, read
// the console. No framework, no observers; just one guarded console.trace.
const TRACE = false;

export const getEditorView = () => editorView;
export function setEditorView(v) {
  editorView = v;
}

export const getCurrentOpenFile = () => currentOpenFile;
export function setCurrentOpenFile(path) {
  if (TRACE)
    console.trace(
      `[editorState] currentOpenFile: ${currentOpenFile} → ${path}`,
    );
  currentOpenFile = path;
  // One-way mirror for the separately-bundled markdown-preview.js, which reads
  // window.app.currentOpenFile to resolve relative image/link paths. editorState
  // remains the single owner/writer.
  if (window.app) window.app.currentOpenFile = path;
}

export const getCurrentTitle = () => currentTitle;
export function setCurrentTitle(t) {
  currentTitle = t;
}

export const getIsSwitchingFile = () => isSwitchingFile;
export function setIsSwitchingFile(v) {
  isSwitchingFile = v;
}

export const getAutoSaveTimeout = () => autoSaveTimeout;
export function setAutoSaveTimeout(id) {
  autoSaveTimeout = id;
}

export const getTriggerAutoSave = () => triggerAutoSave;
export function setTriggerAutoSave(fn) {
  triggerAutoSave = fn;
}

export const getCodeMirrorModules = () => codeMirrorModules;
export function setCodeMirrorModules(m) {
  codeMirrorModules = m;
}

export const getPanzoom = () => currentPanzoom;
export function setPanzoom(p) {
  currentPanzoom = p;
}

// Collections are returned by live reference; callers mutate in place, e.g.
//   getFileScrollPositions()[path] = scroller.scrollTop;
export const getFileScrollPositions = () => fileScrollPositions;
export const getFileCursorPositions = () => fileCursorPositions;
export const getFileReadingModeStates = () => fileReadingModeStates;

// Persistence co-located with the data so callers stop hand-rolling
// JSON.stringify at every call site.
export function persistScrollPositions() {
  localStorage.setItem(
    "vault_file_scrolls",
    JSON.stringify(fileScrollPositions),
  );
}
export function persistCursorPositions() {
  localStorage.setItem(
    "vault_file_cursors",
    JSON.stringify(fileCursorPositions),
  );
}
