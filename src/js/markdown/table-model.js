// table-model.js
//
// Pure GFM-table model layer: parsing markdown source into a { header, aligns,
// rows } model, serializing a model back to aligned markdown, and rendering
// inline cell content (bold/italic/code/links/math) to HTML. None of this
// depends on CodeMirror, so it lives outside the getTableExtension() closure
// and is imported by markdown-table.js.

import { katexOptions } from "./katex-macros.js";

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(?<!\\)\|$/.test(s)) s = s.replace(/\|$/, "");
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function parseTable(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const header = splitRow(lines[0] ?? "");
  const delim = lines.length > 1 ? splitRow(lines[1]) : [];
  const aligns = header.map((_, i) => {
    const d = (delim[i] || "").trim();
    const l = d.startsWith(":");
    const r = d.endsWith(":") && d.length > 1;
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return null;
  });
  const rows = lines.slice(2).map((ln) => {
    const cells = splitRow(ln);
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  return { header, aligns, rows };
}

const WIDE_RE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function vw(s) {
  let w = 0;
  for (const ch of s) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}

export const escCell = (s) => s.replace(/\|/g, "\\|");

function padCell(s, width, align) {
  const pad = Math.max(0, width - vw(s));
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
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let w = Math.max(3, vw(escCell(model.header[c] ?? "")));
    for (const row of model.rows) w = Math.max(w, vw(escCell(row[c] ?? "")));
    widths.push(w);
  }
  const line = (cells) =>
    "| " +
    cells.map((s, c) => padCell(s, widths[c], model.aligns[c])).join(" | ") +
    " |";
  const out = [line(model.header.map(escCell))];
  out.push(
    "| " +
      widths.map((w, c) => delimCell(w, model.aligns[c])).join(" | ") +
      " |",
  );
  for (const row of model.rows) out.push(line(row.map(escCell)));
  return out.join("\n");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Preprocess and render inline cell content to HTML, preserving inline math
// ($…$) safely by tokenizing it out before HTML-escaping and restoring it as
// KaTeX target spans afterward.
export function renderInline(raw) {
  const mathTokens = [];
  let temp = raw.replace(/\$([^$]+)\$/g, (m, p1) => {
    mathTokens.push(p1);
    return `__MATH_TOKEN_${mathTokens.length - 1}__`;
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

  mathTokens.forEach((math, i) => {
    const escapedMath = escapeHtml(math);
    h = h.replace(
      `__MATH_TOKEN_${i}__`,
      `<span class="cm-md-table-math" data-math="${escapedMath}"></span>`,
    );
  });

  return h;
}

// Render math ($…$) inside a rendered table cell with KaTeX.
export function renderTableMath(cell) {
  if (!window.katex) return;
  cell.querySelectorAll(".cm-md-table-math").forEach((el) => {
    const mathRaw = el
      .getAttribute("data-math")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"');
    try {
      window.katex.render(mathRaw, el, katexOptions());
    } catch (e) {
      el.textContent = "$" + mathRaw + "$";
    }
  });
}
