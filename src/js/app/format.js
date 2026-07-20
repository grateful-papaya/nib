// js/app/format.js
// Pure display formatters. No DOM, no state — safe to import anywhere.

const KB = 1024;
const MB = KB * 1024;

/**
 * Human-readable byte count.
 *
 * This replaces the two near-identical implementations that used to exist:
 * Utils.formatBytes (tooltip) and a local formatSize (restore list). The only
 * difference between them was rounding precision in the KB/MB ranges, which
 * nothing depended on.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(2)} MB`;
}

/**
 * Unix seconds -> local date/time. Zero/absent timestamps are common for
 * virtual tree roots, which have no real stat() behind them.
 *
 * @param {number} unixSeconds
 * @returns {string}
 */
export function formatDate(unixSeconds) {
  if (!unixSeconds) return "Unknown";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SNAPSHOT_NAME_PATTERN =
  /^vault_(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2})\d{2})?\.7z$/;

/**
 * Snapshot filename -> label.
 *   vault_2026-07-14_183012.7z -> "2026-07-14 18:30"   (quit mode)
 *   vault_2026-07-14.7z        -> "2026-07-14 · end of day" (daily mode)
 *
 * Unrecognized names are shown verbatim rather than hidden: a file sitting in
 * .backup/snapshots/ that we can't parse is still a restore candidate.
 *
 * @param {string} name
 * @returns {string}
 */
export function formatSnapshotName(name) {
  const match = SNAPSHOT_NAME_PATTERN.exec(name);
  if (!match) return name;
  const [, date, hour, minute] = match;
  return hour ? `${date} ${hour}:${minute}` : `${date} · end of day`;
}

/**
 * Split "/a/b/note.md" into its directory, stem and extension. Four separate
 * call sites hand-rolled this with lastIndexOf pairs; two of them disagreed on
 * what to do with a dotless filename.
 *
 * @param {string} path
 * @returns {{ dir: string, stem: string, ext: string }}
 */
export function splitPath(path) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const base = path.slice(slash + 1);

  const dot = base.lastIndexOf(".");
  // A leading dot is part of the name (".gitignore"), not an extension.
  if (dot <= 0) return { dir, stem: base, ext: ".md" };
  return { dir, stem: base.slice(0, dot), ext: base.slice(dot) };
}
