// codemirror-entry.js
//
// esbuild entry point. Bundle with:
//   npx esbuild src/codemirror-entry.js --bundle --format=esm \
//     --outfile=src/js/libs/codemirror.js
//
// Re-exports the CodeMirror surface Nib's markdown/* modules destructure
// from the dynamic `await import("./libs/codemirror.js")` in
// markdown-preview.js. Every name below was verified against the installed
// package's actual exports (not assumed) before being added here.

export { EditorState, Prec, StateField } from "@codemirror/state";
export {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
} from "@codemirror/view";
export { basicSetup } from "codemirror";
export {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
export { tags } from "@lezer/highlight";
export {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkupCommand,
  deleteMarkupBackward,
} from "@codemirror/lang-markdown";

// ── New in this build ─────────────────────────────────────────────────────
// Needed by markdown/keymaps.js (Mod-h find & replace panel) and
// markdown-preview.js (nested language highlighting inside fenced code).
export { openSearchPanel } from "@codemirror/search";
export { languages } from "@codemirror/language-data";
