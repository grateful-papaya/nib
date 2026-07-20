// js/app/editorSurface.js
// Behavior of the editor surface itself: wheel momentum, the read/edit
// toggle, and link activation from rendered markdown.
//
// These three are the things that respond to a pointer inside .cm-editor, so
// they tend to be touched together when the editing experience changes.
// Was the scroll half of InteractionManager + the editor half of EventBinder.

import { showToast } from "../utils.js";
import { revealInSidebar } from "../file-tree.js";
import { isScrollbarDragging } from "../state/uiState.js";
import { getVaultPath } from "../state/appState.js";
import {
  getCurrentOpenFile,
  getFileReadingModeStates,
  applyReadingModeToEditor,
} from "../state/editorState.js";
import { byId, findTreeFileLabel } from "./dom.js";

// ─── Elastic wheel scrolling ──────────────────────────────────────────────

const MOUSE_MULTIPLIER = 2.5;
const MOUSE_FRICTION = 0.12;
// A trackpad reports fractional or small deltas; a wheel notch reports a
// large integer one.
const WHEEL_NOTCH_MIN = 18;
// Below this the remaining distance is sub-pixel; snap and stop.
const SETTLE_EPSILON = 0.5;

export function initElasticScroll() {
  const bodyArea = byId("editor-body");
  if (!bodyArea) return;

  let targetScrollTop = 0;
  let animationId = null;
  // The .cm-scroller is replaced wholesale on every file switch, so this is
  // cached with an isConnected guard rather than resolved once. Previously it
  // was re-queried on every single wheel event.
  let scroller = null;

  const getScroller = () => {
    if (!scroller || !scroller.isConnected) {
      scroller = bodyArea.querySelector(".cm-scroller");
    }
    return scroller;
  };

  const stopAnimation = () => {
    if (animationId === null) return;
    cancelAnimationFrame(animationId);
    animationId = null;
  };

  bodyArea.addEventListener("mousedown", () => {
    if (animationId === null) return;
    stopAnimation();
    const el = getScroller();
    if (el) targetScrollTop = el.scrollTop;
  });

  bodyArea.addEventListener(
    "wheel",
    (e) => {
      if (isScrollbarDragging()) return;

      const el = getScroller();
      if (!el) return;

      const isTrackpad =
        !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < WHEEL_NOTCH_MIN;
      if (isTrackpad) {
        // Hand control back mid-glide rather than letting the two compete.
        stopAnimation();
        return;
      }

      e.preventDefault();

      const maxScroll = el.scrollHeight - el.clientHeight;
      if (animationId === null) targetScrollTop = el.scrollTop;
      targetScrollTop = Math.min(
        maxScroll,
        Math.max(0, targetScrollTop + e.deltaY * MOUSE_MULTIPLIER),
      );

      if (animationId !== null) return;

      const step = () => {
        if (isScrollbarDragging() || !el.isConnected) {
          animationId = null;
          return;
        }
        const diff = targetScrollTop - el.scrollTop;
        if (Math.abs(diff) < SETTLE_EPSILON) {
          el.scrollTop = targetScrollTop;
          animationId = null;
          return;
        }
        el.scrollTop += diff * MOUSE_FRICTION;
        animationId = requestAnimationFrame(step);
      };
      animationId = requestAnimationFrame(step);
    },
    { passive: false },
  );

  // Capture phase: scroll does not bubble, so a listener on the container only
  // sees the descendant's event during capture.
  bodyArea.addEventListener(
    "scroll",
    (e) => {
      const el = e.target.closest?.(".cm-scroller");
      if (!el) return;
      // Any scroll we did not drive (keyboard, scrollbar, programmatic) is the
      // new truth; adopt it so the next wheel event eases from the right spot.
      if (animationId === null || isScrollbarDragging()) {
        targetScrollTop = el.scrollTop;
      }
    },
    true,
  );
}

// ─── Reading mode ─────────────────────────────────────────────────────────

export function initReadingModeToggle() {
  const btn = byId("read-mode-btn");
  if (!btn) return;

  const icon = btn.querySelector("img");

  btn.addEventListener("click", () => {
    const editor = byId("file-editor");
    if (!editor || editor.classList.contains("hidden")) return;

    const path = getCurrentOpenFile();
    if (!path) return;

    const states = getFileReadingModeStates();
    const reading = !states[path];
    states[path] = reading;

    btn.classList.toggle("active", reading);
    btn.title = reading ? "Toggle Editing Mode" : "Toggle Reading Mode";
    editor.classList.toggle("reading-mode", reading);

    if (icon) {
      icon.src = reading ? "assets/edit_mode.svg" : "assets/read_mode.svg";
    }

    const title = byId("editor-title");
    if (title) title.readOnly = reading;

    // Was: contentDOM.setAttribute("contenteditable", …). CodeMirror owns that
    // attribute and rewrites it from its own facet, and the write told the
    // editor's state nothing — so the live preview kept revealing raw
    // markdown/math and the table kept offering its editing UI. This routes
    // through EditorState.readOnly / EditorView.editable instead, which the
    // preview extensions read.
    applyReadingModeToEditor();

    showToast(reading ? "Reading Mode enabled." : "Editing Mode enabled.");
  });
}

// ─── Link activation ──────────────────────────────────────────────────────

const HTTP_URL = /^https?:\/\//i;
const HAS_EXTENSION = /\.[^/]+$/;

/**
 * @param {string} url
 */
export function openExternalLink(url) {
  if (!url || !HTTP_URL.test(url)) return;
  try {
    api.openExternalUrl({ url });
  } catch (err) {
    console.error("[Links] Failed to open external link:", err);
  }
}

/**
 * Resolve a relative or vault-absolute markdown link to a real path.
 *
 * Returns null when the link escapes the vault. Kept separate from the
 * navigation below so the containment rule is testable on its own — it is the
 * only thing standing between a `../../../etc/passwd` link and a read.
 *
 * @param {string} rawPath href as written in the document
 * @returns {string|null}
 */
export function resolveInternalPath(rawPath) {
  const vault = getVaultPath();
  if (!vault) return null;

  let rel = rawPath.split(/[?#]/)[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // Malformed percent-encoding: fall through with the raw text, which is
    // still better than dropping the click silently.
  }
  if (!rel) return null;

  let baseDir;
  if (rel.startsWith("/")) {
    baseDir = vault;
    rel = rel.replace(/^\/+/, "");
  } else {
    const current = getCurrentOpenFile();
    baseDir =
      current && current.includes("/")
        ? current.slice(0, current.lastIndexOf("/"))
        : vault;
  }

  const parts = baseDir.split("/");
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }

  let target = parts.join("/");
  if (target !== vault && !target.startsWith(`${vault}/`)) return null;
  if (!HAS_EXTENSION.test(target)) target += ".md";
  return target;
}

/**
 * @param {string} rawPath
 */
export function openInternalLink(rawPath) {
  const target = resolveInternalPath(rawPath);
  if (target === null) {
    if (getVaultPath()) showToast("Link points outside the workspace.");
    return;
  }

  revealInSidebar(target);

  const label = findTreeFileLabel(target, true);
  if (label) label.click();
  else showToast("Linked file not found.");
}

export function initLinks() {
  window.app.openExternalLink = openExternalLink;
  window.app.openInternalLink = openInternalLink;

  document.addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (!link?.href || !HTTP_URL.test(link.href)) return;
    e.preventDefault();
    openExternalLink(link.href);
  });
}
