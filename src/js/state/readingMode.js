// state/readingMode.js
// Reading mode <-> CodeMirror bridge.
//
// Reading mode used to be cosmetic: a `reading-mode` class plus a raw
// contentDOM.setAttribute("contenteditable", "false"). CodeMirror owns that
// attribute -- it re-asserts it from the EditorView.editable facet on the next
// update -- so the write was fragile and, worse, invisible to editor state.
// The live-preview extensions had no way to know they were in a reader, which
// is why markdown, math and tables all still revealed raw source on click and
// why table editing UI kept appearing.
//
// Setting the real facets fixes both ends: CodeMirror stops accepting input and
// manages contenteditable itself, and markdown-preview.js / markdown-table.js
// can gate reveal on state.readOnly.
//
// The facets live in a Compartment so they can be swapped per toggle. The view
// is rebuilt on every file switch, so the compartment is stored ON the view
// rather than in module scope: reconfiguring a compartment absent from a given
// state's config is a silent no-op, which is exactly the bug this avoids. The
// first call for a view appends it; later calls reconfigure.

const COMPARTMENT_KEY = "_readingModeCompartment";

let modulePromise = null;
let warned = false;

function loadCmApi(modules) {
  if (modules?.Compartment && modules?.StateEffect) {
    return Promise.resolve(modules);
  }
  modulePromise ||= import("../libs/codemirror.js");
  return modulePromise;
}

function warnOnce() {
  if (warned) return;
  warned = true;
  console.log(
    "[readingMode] needs Compartment/StateEffect from the CodeMirror bundle -- " +
      "rebuild js/libs/codemirror.js from codemirror-entry.js (npx esbuild ...).",
  );
}

/**
 * Push `want` (read-only or not) into a CodeMirror view.
 *
 * @param {EditorView} view          target view; ignored when destroyed
 * @param {boolean}    want          true = reading mode
 * @param {object}     modules       preloaded CodeMirror module namespace
 * @param {() => any}  getLiveView   current view, re-checked after the await
 */
export async function applyReadingMode(view, want, modules, getLiveView) {
  if (!view || view.destroyed || view.state.readOnly === want) return;

  const cm = await loadCmApi(modules);
  const { Compartment, EditorState, EditorView, StateEffect } = cm || {};
  if (!Compartment || !StateEffect || !EditorState || !EditorView) {
    warnOnce();
    return;
  }

  // The await yields; a file switch may have torn the view down in between,
  // and dispatching into a dead view throws.
  const live = getLiveView?.();
  if (view.destroyed || (live && view !== live)) return;
  if (view.state.readOnly === want) return;

  const config = [
    EditorState.readOnly.of(want),
    EditorView.editable.of(!want),
  ];

  const existing = view[COMPARTMENT_KEY];
  if (existing) {
    view.dispatch({ effects: existing.reconfigure(config) });
    return;
  }

  const compartment = new Compartment();
  view[COMPARTMENT_KEY] = compartment;
  view.dispatch({
    effects: StateEffect.appendConfig.of(compartment.of(config)),
  });
}
