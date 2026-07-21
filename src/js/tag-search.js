import { getVaultPath } from "./state/appState.js";
import { isTagName } from "./markdown/scanner.js";

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
// Matching is PREFIX-based on the Rust side (`tag_matches`): `#태` finds
// files tagged `#태그`, `tag:phys` finds `#physics`. This is what replaced
// the autocomplete dropdown — instead of completing the tag and then
// searching exactly, a partial tag simply IS a valid query.
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

// The letter-first rule above stops most colour codes, but not the ones made
// entirely of a-f: `#fff`, `#abc`, `#facade`, `#deface`, `#beefed` all satisfy
// it. isTagName excludes those, and is imported from the editor's scanner
// rather than restated here so the tag index, `tag:` search and the editor's
// colour swatch can't drift apart — a swatch shown beside a literal that ALSO
// appeared in tag autocomplete was the visible symptom of them disagreeing.
// Keep the Rust extractor's rule in step with it too.

export const parseTagQuery = (raw) => {
  const include = [];
  const exclude = [];
  const text = String(raw || "")
    .replace(TAG_TOKEN_RE, (m, lead, neg, tag) => {
      // A colour code isn't a tag: leave the token in the free text so
      // searching "#fff" still finds files that literally contain it.
      if (!isTagName(tag)) return m;
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
    if (!isTagName(t)) return; // colour code, not a tag
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

// The tag autocomplete dropdown that used to live here is gone on purpose.
// It was a second clickable list stacked on the same anchor as the results
// dropdown, and clicking its rows completed the query instead of navigating —
// two lists that look alike but answer clicks differently is a trap, not a
// feature. Tag queries now surface in the ONE results list like everything
// else, with a "#tag" chip on each row (see renderAllResults in
// titlebar-search.js).
