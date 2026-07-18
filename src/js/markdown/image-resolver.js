// image-resolver.js
//
// Image path resolution and caching for the live preview. Exposed as a factory
// because writeImageWidth needs syntaxTree from the dynamically-imported
// CodeMirror bundle; the rest only touches window.app / window.api. Returns the
// resolver helpers consumed by the image widget and the live-preview plugin.

class LRUCache {
  constructor(maxSize = 50) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  has(key) {
    return this.cache.has(key);
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    // On a cache hit, delete and re-insert to mark the entry most-recently-used.
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // At capacity, evict the oldest entry (the first key in the Map).
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

export function createImageResolver({ syntaxTree }) {
  const imgCache = new LRUCache(50); // keep at most 50 images

  const normalizePath = (path) => {
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
  };

  // Resolve a markdown src to an absolute filesystem path. Absolute paths pass
  // through; relative paths resolve against the directory of the open file.
  const toAbsolutePath = (raw) => {
    let p = raw.replace(/^file:\/\//, "");
    if (p.startsWith("/")) return p; // POSIX absolute
    if (/^[A-Za-z]:[\\/]/.test(p)) return p; // Windows absolute
    // Intentional window.app interop boundary. This module is loaded via
    // dynamic import() from file-tree.js and lives outside the static import
    // graph, so it reads editor state through window.app rather than importing
    // editorState directly (which would create a second, graph-invisible
    // resolution path for the same state). Do not migrate to a state module.
    const cur = window.app && window.app.currentOpenFile;
    if (!cur) return null; // no base dir → can't resolve a relative path
    const dir = cur.slice(0, cur.lastIndexOf("/"));
    return normalizePath(dir + "/" + p);
  };

  // Async: turn a raw src into something usable in <img>.src.
  const resolveImageSrc = async (raw) => {
    const s = raw.trim();
    if (/^(https?:|data:)/i.test(s)) return s; // remote / data URI → direct
    const filePath = toAbsolutePath(s);
    if (!filePath) return null;
    if (imgCache.has(filePath)) return imgCache.get(filePath);
    if (!window.api || typeof window.api.readImageBase64 !== "function")
      return null;
    const b64 = await window.api.readImageBase64({ filePath });
    const ext = (s.split(".").pop() || "").toLowerCase().replace(/[?#].*$/, "");
    let mime = ext;
    if (ext === "jpg") mime = "jpeg";
    if (ext === "svg") mime = "svg+xml";
    const url = `data:image/${mime};base64,${b64}`;
    imgCache.set(filePath, url);
    return url;
  };

  // Synchronous fast path: remote/data URIs and already-cached local files can
  // set <img>.src immediately. Only genuinely-uncached local files need the
  // async read. This avoids the one-frame height:0 collapse (and the layout
  // shift / scroll jump it causes) whenever an image widget is re-rendered.
  const resolveImageSrcSync = (raw) => {
    const s = raw.trim();
    if (/^(https?:|data:)/i.test(s)) return s;
    const filePath = toAbsolutePath(s);
    if (filePath && imgCache.has(filePath)) return imgCache.get(filePath);
    return null;
  };

  // Persist a resized width back into the document as "![alt|WIDTH](src)"
  // (Obsidian's convention). Resolve the Image node from the drag handle's
  // position so it survives rebuilds, then rewrite just the alt region.
  const writeImageWidth = (view, handleEl, width) => {
    const pos = view.posAtDOM(handleEl);
    let n = syntaxTree(view.state).resolveInner(pos, -1);
    while (n && n.name !== "Image") n = n.parent;
    if (!n) return;
    const m = /^!\[([^\]]*)\]/.exec(view.state.doc.sliceString(n.from, n.to));
    if (!m) return;
    const altFrom = n.from + 2;
    const altTo = altFrom + m[1].length;
    let base = m[1];
    const pipe = base.lastIndexOf("|");
    if (pipe >= 0 && /^\d+$/.test(base.slice(pipe + 1).trim()))
      base = base.slice(0, pipe);
    view.dispatch({
      changes: { from: altFrom, to: altTo, insert: `${base}|${width}` },
      userEvent: "input.imageResize",
    });
  };

  return {
    imgCache,
    normalizePath,
    toAbsolutePath,
    resolveImageSrc,
    resolveImageSrcSync,
    writeImageWidth,
  };
}
