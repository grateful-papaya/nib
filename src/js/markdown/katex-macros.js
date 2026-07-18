// katex-macros.js
//
// Shared KaTeX macro table for every render site in the live preview.
// KaTeX ships a much smaller command set than a full LaTeX distribution, so
// commands that come from packages (siunitx, gensymb, physics, …) are
// "Undefined control sequence" and — because every call site uses
// throwOnError:false — leak into the output as red raw text instead of
// failing loudly. Defining them here once keeps body math (widgets.js
// MathWidget) and table-cell math (table-model.js renderTableMath) in sync;
// a macro added on only one side produced exactly that split before.
//
// Pure data: no KaTeX or CodeMirror dependency, so both the static import
// graph and the dynamically-imported preview bundle can share it.

export const KATEX_MACROS = {
  // Units — \ohm is siunitx/gensymb, not core KaTeX.
  "\\ohm": "\\Omega",
  "\\micro": "\\mu",
  "\\degree": "^{\\circ}",
  "\\celsius": "^{\\circ}\\mathrm{C}",
  "\\angstrom": "\\mathrm{\\mathring{A}}",

  // Common shorthands that are easy to reach for and cheap to support.
  "\\diff": "\\mathrm{d}",
  "\\abs": "\\left|#1\\right|",
  "\\norm": "\\left\\|#1\\right\\|",
};

// Spread into a KaTeX options object. KaTeX MUTATES the macros object it is
// given (it caches expansions into it), so every call site must get its own
// copy — sharing one literal would let one render's cache bleed into another.
export const katexOptions = (extra) => ({
  throwOnError: false,
  ...extra,
  macros: { ...KATEX_MACROS },
});
