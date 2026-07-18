// glyphs.js
//
// Static data for arrow/comparison glyph substitution in the live preview.
// Pure module: no CodeMirror dependency. Consumed by the live-preview plugin
// in markdown-preview.js.

export const GLYPHS = [
  ["-->", "⟶"],
  ["<--", "⟵"],
  ["==>", "⟹"],
  ["<==", "⟸"],
  ["->", "→"],
  ["<-", "←"],
  ["=>", "⇒"],
  ["<=", "⇐"],
  ["=<", "≤"],
  [">=", "≥"],
  ["!=", "≠"],
];

export const GLYPH_RE = new RegExp(
  GLYPHS.map(([s]) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g",
);

export const GLYPH_MAP = new Map(GLYPHS);

// Bidirectional arrows: "<" + a run of "-" (or "=") + ">".
//   run 1..2  -> a single glyph  (<->, <-->  ->  ↔ / ⟷ ;  <=>, <==>  ->  ⇔ / ⟺)
//   run >= 3  -> ONLY the two ends convert ("<-" -> ←, "->" -> →), and the
//               dashes in the middle stay raw text (←--→ etc.). No single
//               glyph is wide enough for 3+, and splitting the ends keeps the
//               reveal symmetric.
export const BIARROW_RE = /<(-+|=+)>/g;

export const biSingle = (dash, n) =>
  dash ? (n === 1 ? "↔" : "⟷") : n === 1 ? "⇔" : "⟺";
export const biLeft = (dash) => (dash ? "←" : "⇐");
export const biRight = (dash) => (dash ? "→" : "⇒");
