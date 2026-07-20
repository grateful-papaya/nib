// table-model.js
//
// The pure GFM-table model layer, end to end: parsing markdown source into a
// { header, aligns, rows } model, mutating that model (insert/delete/move/
// align), serializing it back to aligned markdown, and rendering inline cell
// content (bold/italic/code/links/math) to HTML. Nothing here depends on
// CodeMirror or on the DOM, so all of it is directly testable under node.

import { katexOptions } from "./katex-macros.js";

// ── Parsing ────────────────────────────────────────────────────────────────

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(?<!\\)\|$/.test(s)) s = s.replace(/\|$/, "");
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(delim) {
  const d = (delim || "").trim();
  const left = d.startsWith(":");
  const right = d.endsWith(":") && d.length > 1;
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

export function parseTable(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const header = splitRow(lines[0] ?? "");
  const delim = lines.length > 1 ? splitRow(lines[1]) : [];
  const aligns = header.map((_, i) => alignOf(delim[i]));
  const rows = lines.slice(2).map((ln) => {
    const cells = splitRow(ln);
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  return { header, aligns, rows };
}

// ── Serializing ────────────────────────────────────────────────────────────

// Visual width: CJK / fullwidth code points occupy two terminal columns, so the
// padding math has to count them as 2 to keep the source columns aligned.
// Ranges checked numerically — a per-character regex test was the hot spot when
// serializing a large table on every keystroke.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function visualWidth(s) {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

export const escCell = (s) => s.replace(/\|/g, "\\|");

function padCell(s, width, align) {
  const pad = Math.max(0, width - visualWidth(s));
  if (pad === 0) return s;
  if (align === "right") return " ".repeat(pad) + s;
  if (align === "center") {
    const l = Math.floor(pad / 2);
    return " ".repeat(l) + s + " ".repeat(pad - l);
  }
  return s + " ".repeat(pad);
}

function delimCell(width, align) {
  const w = Math.max(3, width);
  if (align === "center") return ":" + "-".repeat(w - 2) + ":";
  if (align === "right") return "-".repeat(w - 1) + ":";
  if (align === "left") return ":" + "-".repeat(w - 1);
  return "-".repeat(w);
}

export function serializeTable(model) {
  const cols = model.header.length;
  // Escape once, up front: every cell is measured and then emitted, so the old
  // shape ran escCell twice per cell per serialize.
  const header = model.header.map(escCell);
  const rows = model.rows.map((row) => row.map((c) => escCell(c ?? "")));

  const widths = [];
  for (let c = 0; c < cols; c++) {
    let w = Math.max(3, visualWidth(header[c] ?? ""));
    for (const row of rows) w = Math.max(w, visualWidth(row[c] ?? ""));
    widths.push(w);
  }

  const line = (cells) =>
    "| " +
    cells.map((s, c) => padCell(s ?? "", widths[c], model.aligns[c])).join(" | ") +
    " |";

  const out = [line(header)];
  out.push(
    "| " + widths.map((w, c) => delimCell(w, model.aligns[c])).join(" | ") + " |",
  );
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

// ── Inline rendering ───────────────────────────────────────────────────────

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (s) => s.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);

const HTML_UNESCAPES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"' };
const unescapeHtml = (s) =>
  s.replace(/&(?:lt|gt|amp|quot);/g, (ent) => HTML_UNESCAPES[ent]);

// Render inline cell content to HTML, preserving inline math ($…$) safely by
// tokenizing it out before HTML-escaping and restoring it as KaTeX target
// spans afterward.
export function renderInline(raw) {
  const mathTokens = [];
  const temp = raw.replace(/\$([^$]+)\$/g, (_m, tex) => {
    mathTokens.push(tex);
    return `\u0000MATH${mathTokens.length - 1}\u0000`;
  });

  let h = escapeHtml(temp);
  h = h.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/\*([^*\s][^*]*)\*/g, "<i>$1</i>");
  h = h.replace(
    /\[([^\]]*)\]\(([^)]*)\)/g,
    '<span class="cm-md-table-link">$1</span>',
  );

  // NUL-delimited placeholders can't appear in a document, so this can't be
  // spoofed by cell text the way a "__MATH_TOKEN_n__" literal could.
  return h.replace(/\u0000MATH(\d+)\u0000/g, (_m, i) => {
    const tex = escapeHtml(mathTokens[Number(i)]);
    return `<span class="cm-md-table-math" data-math="${tex}"></span>`;
  });
}

// Render math ($…$) inside a rendered table cell with KaTeX.
export function renderTableMath(cell) {
  if (!window.katex) return;
  for (const el of cell.querySelectorAll(".cm-md-table-math")) {
    const tex = unescapeHtml(el.getAttribute("data-math") || "");
    try {
      window.katex.render(tex, el, katexOptions());
    } catch {
      el.textContent = "$" + tex + "$";
    }
  }
}

// ── Structural mutation ────────────────────────────────────────────────────
// Every op edits the model in place; callers serialize the result afterwards.

const emptyRow = (cols) => Array.from({ length: cols }, () => "");

export const ops = {
  insertRow(m, i) {
    m.rows.splice(i, 0, emptyRow(m.header.length));
  },
  deleteRow(m, i) {
    m.rows.splice(i, 1);
  },
  duplicateRow(m, i) {
    m.rows.splice(i + 1, 0, [...m.rows[i]]);
  },
  insertCol(m, i) {
    m.header.splice(i, 0, "");
    m.aligns.splice(i, 0, null);
    for (const r of m.rows) r.splice(i, 0, "");
  },
  deleteCol(m, i) {
    m.header.splice(i, 1);
    m.aligns.splice(i, 1);
    for (const r of m.rows) r.splice(i, 1);
  },
  duplicateCol(m, i) {
    m.header.splice(i + 1, 0, m.header[i]);
    m.aligns.splice(i + 1, 0, m.aligns[i]);
    for (const r of m.rows) r.splice(i + 1, 0, r[i]);
  },
  moveRow(m, from, to) {
    const [row] = m.rows.splice(from, 1);
    m.rows.splice(to, 0, row);
  },
  moveCol(m, from, to) {
    const move = (arr) => {
      const [v] = arr.splice(from, 1);
      arr.splice(to, 0, v);
    };
    move(m.header);
    move(m.aligns);
    for (const r of m.rows) move(r);
  },
  setAlign(m, i, align) {
    m.aligns[i] = align;
  },
};

// Row index -1 addresses the header row, matching the data-r attribute the DOM
// carries, so cell coordinates are uniform everywhere above this layer.
export const getCell = (m, r, c) => (r < 0 ? m.header[c] : m.rows[r]?.[c]) ?? "";

export const setCell = (m, r, c, v) => {
  if (r < 0) m.header[c] = v;
  else if (m.rows[r]) m.rows[r][c] = v;
};

export function fillCells(m, sel, value = "") {
  for (let r = sel.r1; r <= sel.r2; r++)
    for (let c = sel.c1; c <= sel.c2; c++) setCell(m, r, c, value);
}
