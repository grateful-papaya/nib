// state/editorState.js
// Owns the live editor session: the CodeMirror view, which file is open,
// per-file scroll/cursor/reading-mode memory, and autosave plumbing.
//
// CONSOLIDATION NOTE
// currentOpenFile / fileScrollPositions / fileCursorPositions each used to
// exist TWICE -- once at window.app.* (written by file-tree.js) and once at
// window.app.state.editor.* (read/written by app.js). The rename handler
// operated on the state.editor copy while everything else used the top-level
// copy, so scroll/cursor migration on rename silently no-op'd. There is now
// exactly one of each, and setCurrentOpenFile() is the single choke point.

import { readObject, writeJSON } from "./storage.js";
import { applyReadingMode } from "./readingMode.js";

const SCROLLS_KEY = "vault_file_scrolls";
const CURSORS_KEY = "vault_file_cursors";

// Flip to true to log every open-file change with a stack trace. This is the
// direct answer to "who changed this value and when?" -- set it, reproduce,
// read the console. No framework, no observers; one guarded console.trace.
const TRACE = false;

const session = {
  view: null,
  openFile: null,
  title: "",
  switchingFile: false,
  autoSaveTimeout: null,
  triggerAutoSave: null,
  codeMirrorModules: null,
  panzoom: null,
};

// Collections are handed out by live reference; callers mutate in place, e.g.
//   getFileScrollPositions()[path] = scroller.scrollTop;
const fileScrollPositions = readObject(SCROLLS_KEY);
const fileCursorPositions = readObject(CURSORS_KEY);
const fileReadingModeStates = Object.create(null);

// ---- Reading mode ---------------------------------------------------------

/**
 * Re-assert the stored reading-mode state onto a view. Cheap and idempotent:
 * applyReadingMode() returns immediately when the view already matches.
 */
export function applyReadingModeToEditor(view = session.view) {
  return applyReadingMode(
    view,
    !!fileReadingModeStates[session.openFile],
    session.codeMirrorModules,
    () => session.view,
  );
}

// ---- Editor view ----------------------------------------------------------

export const getEditorView = () => session.view;

export function setEditorView(view) {
  session.view = view;
  // A file switch builds a fresh view whose config knows nothing about reading
  // mode, so re-assert it here rather than making every call site remember to.
  if (view) applyReadingModeToEditor(view);
}

// ---- Open file ------------------------------------------------------------

export const getCurrentOpenFile = () => session.openFile;

export function setCurrentOpenFile(path) {
  if (TRACE) {
    console.trace(`[editorState] currentOpenFile: ${session.openFile} -> ${path}`);
  }
  session.openFile = path;
  // Reading mode is remembered per file, so the answer changes here too. Both
  // call orders (view first then path, or the reverse) are covered because
  // setEditorView() re-asserts as well.
  applyReadingModeToEditor();
  // One-way mirror for the separately-bundled markdown-preview.js, which reads
  // window.app.currentOpenFile to resolve relative image/link paths.
  // editorState remains the single owner and writer.
  if (window.app) window.app.currentOpenFile = path;
}

// ---- Plain session slots --------------------------------------------------

export const getCurrentTitle = () => session.title;
export const setCurrentTitle = (t) => {
  session.title = t ?? "";
};

export const getIsSwitchingFile = () => session.switchingFile;
export const setIsSwitchingFile = (v) => {
  session.switchingFile = !!v;
};

export const getAutoSaveTimeout = () => session.autoSaveTimeout;
export const setAutoSaveTimeout = (id) => {
  session.autoSaveTimeout = id;
};

export const getTriggerAutoSave = () => session.triggerAutoSave;
export const setTriggerAutoSave = (fn) => {
  session.triggerAutoSave = fn;
};

export const getCodeMirrorModules = () => session.codeMirrorModules;
export const setCodeMirrorModules = (m) => {
  session.codeMirrorModules = m;
};

export const getPanzoom = () => session.panzoom;
export const setPanzoom = (p) => {
  session.panzoom = p;
};

// ---- Per-file memory ------------------------------------------------------

export const getFileScrollPositions = () => fileScrollPositions;
export const getFileCursorPositions = () => fileCursorPositions;
export const getFileReadingModeStates = () => fileReadingModeStates;

// Persistence co-located with the data so callers stop hand-rolling
// JSON.stringify at every call site.
export const persistScrollPositions = () =>
  writeJSON(SCROLLS_KEY, fileScrollPositions);

export const persistCursorPositions = () =>
  writeJSON(CURSORS_KEY, fileCursorPositions);
