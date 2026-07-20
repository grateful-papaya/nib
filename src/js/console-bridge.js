// js/console-bridge.js
// Mirrors console output to the dev terminal through the native jsLog command.
//
// This has nothing to do with the file tree; it only lived at the top of
// file-tree.js because that module happened to be the first one loaded.
// Import it (for its side effect) from the app entry point instead.

const LEVELS = ["log", "info", "warn", "error"];

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function initConsoleBridge() {
  if (!window.api || typeof window.api.jsLog !== "function") return;
  if (window.__consoleBridgeInstalled) return;
  window.__consoleBridgeInstalled = true;

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args); // keep it in the inspector
      try {
        window.api.jsLog({ msg: `[${level}] ${args.map(stringify).join(" ")}` });
      } catch {
        /* the bridge must never break logging itself */
      }
    };
  }
}
