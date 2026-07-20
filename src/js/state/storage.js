// state/storage.js
// Thin, failure-tolerant localStorage helpers. Every read is guarded because
// a corrupted value must never take the app down, and every write is guarded
// because quota-exceeded is a normal condition, not an error worth throwing.

export function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage full or unavailable. In-memory state stays correct.
    return false;
  }
}

export const readObject = (key) => {
  const v = readJSON(key, {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

export const readStringSet = (key) => {
  const v = readJSON(key, []);
  return new Set(Array.isArray(v) ? v : []);
};
