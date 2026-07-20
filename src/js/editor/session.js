// js/editor/session.js
// Lifecycle of the CodeMirror EditorView: teardown, lazy module loading, and
// construction of a fresh view for a newly opened file.

import { attachScrollbar } from "../scrollbar.js";
import { showToast } from "../utils.js";
import { scheduleTocRefresh } from "../toc.js";
import {
  getEditorView,
  setEditorView,
  getCodeMirrorModules,
  setCodeMirrorModules,
} from "../state/editorState.js";
import { isMarkdownFile } from "../file-types.js";
import { updateEditorStats, resetStatsCache } from "./stats.js";
import { ensureAutoSaveTrigger } from "./autosave.js";

const EDITOR_THEME = {
  "&": { height: "100%", background: "transparent" },
  "&.cm-focused": { outline: "none" },
  // Hide CM's native scrollbar; the custom overlay draws its own.
  ".cm-scroller": { scrollbarWidth: "none" },
  ".cm-scroller::-webkit-scrollbar": {
    width: "0",
    height: "0",
    display: "none",
  },
};

/**
 * Tear down the editor safely.
 *
 * On open, #editor-title is appended into the live .cm-scroller so it scrolls
 * with the document and is positioned by the scroller. CodeMirror's destroy()
 * removes the whole .cm-editor subtree, which would delete the title input
 * along with it — and then the next text-file open can't find #editor-title
 * and bails at its early return, so the file appears not to open. Park the
 * title back in its static home (#editor-content-inner) before destroying so
 * it always survives; the open handler re-adopts it into the new scroller,
 * keeping the exact same layout.
 */
export function destroyEditorView() {
  const view = getEditorView();
  if (!view) return;

  const titleInput = document.getElementById("editor-title");
  const home = document.getElementById("editor-content-inner");
  const body = document.getElementById("editor-body");
  if (titleInput && home && titleInput.parentElement !== home) {
    // Restore original order: title before the editor body.
    home.insertBefore(titleInput, body || null);
  }

  view.destroy();
  setEditorView(null);
  resetStatsCache();
}

// A single in-flight promise, so two rapid file opens can't both kick off the
// dynamic imports. The old code guarded on getCodeMirrorModules() being unset,
// which is still false while the first import is awaiting.
let modulesPromise = null;

/** Lazily load CodeMirror + the markdown live-preview extensions. */
export async function loadEditorModules() {
  const cached = getCodeMirrorModules();
  if (cached) return cached;
  if (modulesPromise) return modulesPromise;

  modulesPromise = (async () => {
    const [cm, mdPreview] = await Promise.all([
      import("../libs/codemirror.js"),
      import("../markdown-preview.js"),
    ]);
    const modules = {
      EditorView: cm.EditorView,
      basicSetup: cm.basicSetup,
      mdExtensions: await mdPreview.getMarkdownExtensions(),
    };
    setCodeMirrorModules(modules);
    return modules;
  })();

  try {
    return await modulesPromise;
  } catch (err) {
    modulesPromise = null; // allow a retry on the next open
    console.error("Failed to initialize editor:", err);
    showToast("Failed to load editor modules. Please check your installation.");
    throw err;
  }
}

/**
 * Build a fresh EditorView for `filePath` and mount it into `parent`.
 * Returns the view (also stored in editorState).
 */
export function createEditorView({ doc, filePath, parent }) {
  const { EditorView, basicSetup, mdExtensions } = getCodeMirrorModules();
  const triggerAutoSave = ensureAutoSaveTrigger();

  destroyEditorView();

  const view = new EditorView({
    doc,
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      isMarkdownFile(filePath) ? mdExtensions || [] : [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          triggerAutoSave();
          // Keep the outline panel in sync while typing (debounced, and a
          // no-op while the panel is hidden).
          scheduleTocRefresh();
        }
        if (update.docChanged || update.selectionSet) {
          updateEditorStats(update.state, { docChanged: update.docChanged });
        }
      }),
      EditorView.theme(EDITOR_THEME),
    ],
    parent,
  });

  setEditorView(view);

  // CM was just recreated, so its .cm-scroller is new — (re)attach the custom
  // overlay scrollbar to it.
  view.scrollDOM.classList.add("custom-scroll");
  attachScrollbar(view.scrollDOM, { editor: true });

  return view;
}

/** Remember where the user was in the file currently loaded in the editor. */
export function captureViewportState(scrollPositions, cursorPositions, path) {
  const view = getEditorView();
  if (!view || !path || !view.scrollDOM) return;
  scrollPositions[path] = view.scrollDOM.scrollTop;
  cursorPositions[path] = view.state.selection.main.head;
}

/** Restore cursor + scroll for a freshly created view. */
export function restoreViewportState(view, { cursor = 0, scroll = 0 } = {}) {
  const safeCursor = Math.min(cursor, view.state.doc.length);
  view.dispatch({ selection: { anchor: safeCursor, head: safeCursor } });

  if (scroll > 0) {
    view.requestMeasure({
      read: () => {},
      write: () => {
        if (!view.destroyed && view.scrollDOM) view.scrollDOM.scrollTop = scroll;
      },
    });
  }
}
