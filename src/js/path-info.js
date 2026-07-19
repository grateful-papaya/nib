import { getVaultPath } from "./state/appState.js";
import { getCurrentOpenFile, getEditorView } from "./state/editorState.js";
import { showToast } from "./utils.js";
import { extractTagsFromText } from "./tag-search.js";

// ─── Breadcrumb info popover ───────────────────────────────────────────────
//
// Metadata for the currently open file, opened from the info button at the
// right end of the expanded breadcrumb. Deliberately NOT a hover tooltip: the
// sidebar tree already has one of those (the fmeta-* panel), and this one is
// interactive — copy actions, clickable tags — so it needs a click to open and
// a stable dismiss contract rather than disappearing the moment the pointer
// leaves the trigger.
const PathInfoManager = (() => {
  let open = false;

  const els = () => ({
    btn: document.getElementById("titlebar-path-info-btn"),
    pop: document.getElementById("titlebar-path-info-popover"),
    name: document.getElementById("path-info-name"),
    fullpath: document.getElementById("path-info-fullpath"),
    rows: document.getElementById("path-info-rows"),
  });

  // Duplicated from app.js's `Utils` rather than imported: those live inside a
  // module-private const object there and aren't exported. Worth hoisting into
  // utils.js eventually so there's a single implementation.
  const formatBytes = (b) => {
    if (b === null || b === undefined) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  };
  // get_file_meta returns UNIX seconds, not milliseconds.
  const formatDate = (unix) =>
    !unix
      ? "Unknown"
      : new Date(unix * 1000).toLocaleString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });

  const relPath = (abs) => {
    const vault = getVaultPath();
    if (!vault || !abs?.startsWith(vault)) return abs || "";
    return abs.slice(vault.length).replace(/^[\\/]/, "");
  };

  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  const render = async () => {
    const { name, fullpath, rows } = els();
    const file = getCurrentOpenFile();
    const vault = getVaultPath();

    if (!file) {
      name.textContent = vault
        ? vault.split(/[\\/]/).filter(Boolean).pop()
        : "No vault";
      fullpath.textContent = vault || "";
      rows.innerHTML = `<div class="path-info-row"><span>Status</span><span>No file open</span></div>`;
      return;
    }

    name.textContent = file.split(/[\\/]/).pop();
    fullpath.textContent = file;

    // Render the cheap half immediately; the metadata call is IPC and would
    // otherwise leave the popover blank for a frame or two after it animates in.
    let meta = {};
    try {
      meta = (await api.getFileMeta({ filePath: file })) || {};
    } catch (_) {}
    if (!open) return; // dismissed while awaiting

    // Tags are read off the live CodeMirror doc rather than the file on disk:
    // the buffer may hold unsaved edits, and a chip that disappears when you
    // save (or appears only after) would be baffling.
    const text = getEditorView()?.state?.doc?.toString() ?? "";
    const tags = text ? extractTagsFromText(text) : [];
    const folder = relPath(file).split(/[\\/]/).slice(0, -1).join(" / ");
    const ext = (file.match(/\.([^.\\/]+)$/) || [, ""])[1].toUpperCase();

    const row = (k, v) =>
      `<div class="path-info-row"><span>${k}</span><span>${v}</span></div>`;

    rows.innerHTML = [
      row("Location", escapeHtml(folder || "(vault root)")),
      row("Type", ext ? `${escapeHtml(ext)} file` : "File"),
      row("Size", formatBytes(meta.size)),
      row("Created", formatDate(meta.created)),
      row("Modified", formatDate(meta.modified)),
      tags.length
        ? `<div class="path-info-row"><span>Tags</span><span class="path-info-tags">${tags
            .map(
              (t) =>
                `<span class="path-info-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`,
            )
            .join("")}</span></div>`
        : "",
    ].join("");
  };

  const close = () => {
    if (!open) return;
    open = false;
    els().pop?.classList.remove("open");
    els().btn?.classList.remove("open");
    document.body.classList.remove("titlebar-info-open");
  };

  const openPopover = async () => {
    open = true;
    els().pop?.classList.add("open");
    els().btn?.classList.add("open");
    // Same reason .titlebar-results-open exists: every nested -webkit-app-region
    // rectangle in the titlebar contributes to Electron's drag map
    // independently, and a stray one swallows the popover's pointer events.
    document.body.classList.add("titlebar-info-open");
    await render();
  };

  const copy = async (value, label) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${label} copied`);
    } catch (_) {
      showToast("Copy failed");
    }
  };

  const init = () => {
    const { btn, pop } = els();
    if (!btn || !pop) return;

    btn.addEventListener("click", (e) => {
      // The segment's own handler returns to path mode while in mode-search;
      // stopping propagation keeps the two from fighting.
      e.stopPropagation();
      if (open) close();
      else openPopover();
    });

    pop.addEventListener("click", (e) => {
      e.stopPropagation();

      const tag = e.target.closest(".path-info-tag");
      if (tag) {
        close();
        window.dispatchEvent(
          new CustomEvent("nib:search-query", {
            detail: `tag:${tag.dataset.tag}`,
          }),
        );
        return;
      }

      const action = e.target.closest(".path-info-action");
      if (!action) return;
      const file = getCurrentOpenFile();
      if (action.id === "path-info-copy-abs") copy(file, "Full path");
      else if (action.id === "path-info-copy-rel")
        copy(relPath(file), "Relative path");
    });

    document.addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && open) {
        e.stopPropagation();
        close();
      }
    });
  };

  return { init, close };
})();

export const initPathInfo = PathInfoManager.init;
export const closePathInfo = PathInfoManager.close;
