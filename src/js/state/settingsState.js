// js/state/settingsState.js
// Owns all persisted user settings (font, spacing, backup snapshot policy).
// Was: window.app.state.settings
//
// A keyed accessor is used deliberately here (not one getter per field): the
// slider/dropdown binding code in app.js already writes by dynamic key
// (state.settings[stateKey] = val), so setSetting(stateKey, val) maps 1:1.

const settings = {
  font_size: "16",
  editor_padding: "12",
  line_spacing: "1.6",
  font_family: "pretendard",
  // Backup snapshot policy (see lib.rs run_backup):
  //   mode: "quit" (a new snapshot on every app quit)
  //       | "daily" (one per day, overwritten so the day's last quit wins)
  //   keep: how many snapshots to retain; 0 disables snapshots
  // These defaults mirror AppSettings::default() in lib.rs -- keep both in
  // sync, since a save fired before loadSettings resolves exports THESE.
  backup_snapshot_mode: "quit",
  backup_snapshot_keep: 5,
};

export const getSetting = (key) => settings[key];
export function setSetting(key, value) {
  settings[key] = value;
}

// Live reference for bulk read / destructuring, e.g.
//   const { font_size, line_spacing } = getAllSettings();
export const getAllSettings = () => settings;
