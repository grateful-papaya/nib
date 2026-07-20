// image-resolver.js
//
// Image path resolution and caching for the live preview. Factory form because
// writeImageWidth needs syntaxTree from the dynamically imported CodeMirror
// bundle; the rest only touches window.app / window.api.

const CACHE_LIMIT = 50;

// Insertion-ordered Map used as an LRU: a hit is deleted and re-inserted to
// become most-recently-used, and the first key is the eviction candidate.
class LRUCache {
  constructor(maxSize = CACHE_LIMIT) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }
  has(key) {
    return this.cache.has(key);
  }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, value);
  }
}

function normalizePath(path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

const MIME_ALIASES = { jpg: "jpeg", svg: "svg+xml" };

// Resolve a markdown src to an absolute filesystem path. Absolute paths pass
// through; relative paths resolve against the directory of the open file.
function toAbsolutePath(raw) {
  const p = raw.replace(/^file:\/\//, "");
  if (p.startsWith("/")) return p; // POSIX absolute
  if (/^[A-Za-z]:[\\/]/.test(p)) return p; // Windows absolute
  // Intentional window.app interop boundary: this module is loaded via dynamic
  // import() and lives outside the static import graph, so it reads editor
  // state through window.app rather than importing editorState directly (which
  // would create a second, graph-invisible resolution path for the same state).
  // Do not migrate to a state module.
  const cur = window.app && window.app.currentOpenFile;
  if (!cur) return null; // no base dir: can't resolve a relative path
  return normalizePath(cur.slice(0, cur.lastIndexOf("/")) + "/" + p);
}

export function createImageResolver({ syntaxTree }) {
  const imgCache = new LRUCache();

  // Synchronous fast path: remote/data URIs and already-cached local files can
  // set <img>.src immediately, avoiding the one-frame height:0 collapse (and
  // the layout shift it causes) whenever an image widget is re-rendered.
  const resolveImageSrcSync = (raw) => {
    const s = raw.trim();
    if (/^(https?:|data:)/i.test(s)) return s;
    const filePath = toAbsolutePath(s);
    return filePath && imgCache.has(filePath) ? imgCache.get(filePath) : null;
  };

  // Async: turn a raw src into something usable in <img>.src.
  const resolveImageSrc = async (raw) => {
    const s = raw.trim();
    if (/^(https?:|data:)/i.test(s)) return s;
    const filePath = toAbsolutePath(s);
    if (!filePath) return null;
    if (imgCache.has(filePath)) return imgCache.get(filePath);
    if (typeof window.api?.readImageBase64 !== "function") return null;

    const b64 = await window.api.readImageBase64({ filePath });
    const ext = (s.split(".").pop() || "").toLowerCase().replace(/[?#].*$/, "");
    const url = `data:image/${MIME_ALIASES[ext] || ext};base64,${b64}`;
    imgCache.set(filePath, url);
    return url;
  };

  // Persist a resized width back into the document as "![alt|WIDTH](src)"
  // (Obsidian's convention). The Image node is resolved from the drag handle's
  // position so it survives rebuilds, then only the alt region is rewritten.
  const writeImageWidth = (view, handleEl, width) => {
    const pos = view.posAtDOM(handleEl);
    let n = syntaxTree(view.state).resolveInner(pos, -1);
    while (n && n.name !== "Image") n = n.parent;
    if (!n) return;
    const m = /^!\[([^\]]*)\]/.exec(view.state.doc.sliceString(n.from, n.to));
    if (!m) return;
    const altFrom = n.from + 2;
    let base = m[1];
    const pipe = base.lastIndexOf("|");
    if (pipe >= 0 && /^\d+$/.test(base.slice(pipe + 1).trim()))
      base = base.slice(0, pipe);
    view.dispatch({
      changes: {
        from: altFrom,
        to: altFrom + m[1].length,
        insert: `${base}|${width}`,
      },
      userEvent: "input.imageResize",
    });
  };

  return { resolveImageSrc, resolveImageSrcSync, writeImageWidth };
}
