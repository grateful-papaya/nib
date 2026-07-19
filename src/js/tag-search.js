import { getVaultPath } from "./state/appState.js";

// ─── Tag query parsing + autocomplete ──────────────────────────────────────
//
// Tag search is NOT a separate mode with its own scope entry. It's a prefix
// understood by the one search input that already exists:
//
//   tag:physics                 files carrying #physics
//   #physics                    same thing, shorthand
//   tag:physics tag:homework    AND
//   -tag:draft                  excluded
//   tag:project/nib             hierarchical — `tag:project` matches this too
//   tag:physics 라그랑지안       tag-filtered, then full-text within the survivors
//
// Making it a mode instead would force the user to decide what kind of search
// they want BEFORE typing it, and would make the mixed form above impossible.
// The parser strips the tag tokens out and hands back whatever free text is
// left, so the two halves can be dispatched independently.

// Deliberately mirrors the Rust extractor's rules: a tag starts with a letter
// or underscore (so `#1`, `#404` and colour-ish `#123456` are never tags) and
// continues with letters/digits/_/-//. \p{L} rather than \w so Korean tags
// (#물리학) work.
const TAG_TOKEN_RE = /(^|\s)(-?)(?:tag:|#)([\p{L}_][\p{L}\p{N}_\-/]{0,63})/gu;

export const parseTagQuery = (raw) => {
  const include = [];
  const exclude = [];
  const text = String(raw || "")
    .replace(TAG_TOKEN_RE, (_m, lead, neg, tag) => {
      (neg ? exclude : include).push(tag);
      return lead;
    })
    .trim();

  return {
    include,
    exclude,
    text,
    isTagQuery: include.length > 0 || exclude.length > 0,
  };
};

// ── live-buffer tag extraction ──
// The Rust index only knows what's on disk. The info popover shows tags for
// the buffer as it is RIGHT NOW, unsaved edits included, so it needs its own
// extractor. Same rules as the Rust one, deliberately: a tag that shows up in
// the popover must be the same tag `tag:` search will find after saving.
export const extractTagsFromText = (text) => {
  const out = [];
  const push = (raw) => {
    const t = String(raw).trim().replace(/^["']|["']$/g, "").replace(/^#/, "");
    if (!t || t.length > 128) return;
    if (!/^[\p{L}_][\p{L}\p{N}_\-/]*$/u.test(t)) return;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };

  let body = text;
  const fm = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (fm) {
    body = text.slice(fm[0].length);
    const flow = fm[1].match(/^(?:tags|tag|keywords):\s*\[(.*?)\]/im);
    if (flow) flow[1].split(",").forEach(push);
    const block = fm[1].match(/^(?:tags|tag|keywords):\s*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/im);
    if (block)
      block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, "")).forEach(push);
    const scalar = fm[1].match(/^(?:tags|tag|keywords):[ \t]+([^\[\n].*)$/im);
    if (scalar) scalar[1].split(/[,\s]+/).forEach(push);
  }

  // Strip fenced blocks and inline code before the inline scan, otherwise
  // every `#include` and `#!/bin/sh` in a snippet becomes a tag.
  const stripped = body
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");

  for (const m of stripped.matchAll(
    /(^|[^\w#/&])#([\p{L}_][\p{L}\p{N}_\-/]{0,63})/gu,
  ))
    push(m[2].replace(/[-/]+$/, ""));

  return out;
};

// ── tag list cache ──
// Rebuilt lazily and never more than once every few seconds: the Rust side is
// already incremental (it only reparses files whose mtime moved), but the
// directory walk plus one stat per file is still real work to be doing on
// every keystroke.
const TAG_LIST_TTL_MS = 4000;
let tagListCache = [];
let tagListFetchedAt = 0;
let tagListInFlight = null;

export const getVaultTags = async ({ force = false } = {}) => {
  const vaultPath = getVaultPath();
  if (!vaultPath) return [];
  if (!force && Date.now() - tagListFetchedAt < TAG_LIST_TTL_MS)
    return tagListCache;
  if (tagListInFlight) return tagListInFlight;

  tagListInFlight = (async () => {
    try {
      tagListCache = (await api.listVaultTags({ vaultPath })) || [];
      tagListFetchedAt = Date.now();
    } catch (err) {
      console.error("Failed to list vault tags:", err);
    } finally {
      tagListInFlight = null;
    }
    return tagListCache;
  })();

  return tagListInFlight;
};

export const invalidateTagList = () => {
  tagListFetchedAt = 0;
};

// ── autocomplete dropdown ──
//
// Built in JS rather than added to index.html: it's transient, it belongs to
// exactly one input, and creating it here keeps the markup edit for this
// feature down to zero. Anchored to .titlebar-search-bar, which is already
// position:relative for the scope menu and results list.
const TagAutocomplete = (() => {
  let menu = null;
  let input = null;
  let items = [];
  let activeIdx = -1;
  let open = false;
  // Token currently under the caret, as [start, end) offsets into input.value.
  let tokenRange = null;

  const ensureMenu = () => {
    if (menu) return menu;
    const bar = document.getElementById("titlebar-search-bar");
    if (!bar) return null;
    menu = document.createElement("div");
    menu.className = "titlebar-tag-suggest";
    menu.id = "titlebar-tag-suggest";
    bar.appendChild(menu);
    // Pointer, not click: a click fires after blur/mousedown reordering has
    // already let the input lose focus and closed the menu.
    menu.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".titlebar-tag-suggest-row");
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      apply(row.dataset.tag);
    });
    return menu;
  };

  // The token being typed is whatever `tag:`/`#` run the caret sits inside.
  // Scanning back from the caret (rather than regex-matching the whole value)
  // is what lets completion work mid-string, not just at the end.
  const currentToken = () => {
    if (!input) return null;
    const caret = input.selectionStart ?? input.value.length;
    const value = input.value;
    let start = caret;
    while (start > 0 && /[\p{L}\p{N}_\-/]/u.test(value[start - 1])) start--;
    if (start === 0) return null;

    let prefixStart = start;
    if (value[start - 1] === "#") {
      prefixStart = start - 1;
    } else if (value.slice(0, start).toLowerCase().endsWith("tag:")) {
      prefixStart = start - 4;
    } else {
      return null;
    }
    if (value[prefixStart - 1] === "-") prefixStart--;

    const before = value[prefixStart - 1];
    if (before !== undefined && !/\s/.test(before)) return null;

    return { start, end: caret, prefixStart, query: value.slice(start, caret) };
  };

  const close = () => {
    open = false;
    activeIdx = -1;
    tokenRange = null;
    menu?.classList.remove("open");
  };

  const render = () => {
    const m = ensureMenu();
    if (!m) return;
    m.innerHTML = "";
    items.forEach((t, i) => {
      const row = document.createElement("div");
      row.className =
        "titlebar-tag-suggest-row" + (i === activeIdx ? " active" : "");
      row.dataset.tag = t.tag;
      const name = document.createElement("span");
      name.className = "titlebar-tag-suggest-name";
      name.textContent = `#${t.tag}`;
      const count = document.createElement("span");
      count.className = "titlebar-tag-suggest-count";
      count.textContent = t.count;
      row.appendChild(name);
      row.appendChild(count);
      m.appendChild(row);
    });
    m.classList.toggle("open", items.length > 0);
    open = items.length > 0;
  };

  const apply = (tag) => {
    if (!input || !tokenRange) return;
    const { start, end } = tokenRange;
    const value = input.value;
    const next = `${value.slice(0, start)}${tag} ${value.slice(end)}`;
    const caret = start + tag.length + 1;
    input.value = next;
    input.setSelectionRange(caret, caret);
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };

  const update = async () => {
    const token = currentToken();
    if (!token) {
      close();
      return;
    }
    tokenRange = token;
    const all = await getVaultTags();
    const q = token.query.toLowerCase();
    items = all
      .filter((t) => !q || t.tag.toLowerCase().includes(q))
      .slice(0, 8);
    // Prefix matches ahead of mid-string ones — typing "phy" should surface
    // #physics before #astrophysics.
    items.sort((a, b) => {
      const ap = a.tag.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.tag.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || b.count - a.count;
    });
    activeIdx = items.length ? 0 : -1;
    render();
  };

  // Returns true if the key was consumed, so the caller knows not to run its
  // own search navigation for it.
  const handleKeydown = (e) => {
    if (!open || items.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      activeIdx =
        (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
        items.length;
      render();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (activeIdx >= 0) {
        apply(items[activeIdx].tag);
        return true;
      }
    }
    if (e.key === "Escape") {
      close();
      return true;
    }
    return false;
  };

  const init = (inputEl) => {
    input = inputEl;
    if (!input) return;
    input.addEventListener("input", update);
    input.addEventListener("click", update);
    input.addEventListener("blur", () => setTimeout(close, 120));
  };

  return { init, handleKeydown, close, update };
})();

export const initTagAutocomplete = TagAutocomplete.init;
export const tagAutocompleteKeydown = TagAutocomplete.handleKeydown;
export const closeTagAutocomplete = TagAutocomplete.close;
