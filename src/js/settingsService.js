// settingsService.js
// Settings persistence. Extracted from app.js's SettingsManager so that both
// app.js and settings.js can trigger a save without importing each other (which
// would form an app <-> settings import cycle). Reads the single source of truth
// in state/settingsState.js and writes through the preload `api` (window.api).

import { getAllSettings } from "./state/settingsState.js";
import { getVaultPath } from "./state/appState.js";

export async function saveAllSettings() {
  if (!getVaultPath()) return;

  const {
    font_family,
    editor_padding,
    font_size,
    line_spacing,
    backup_snapshot_mode,
    backup_snapshot_keep,
  } = getAllSettings();

  try {
    await api.saveSettings({
      vaultPath: getVaultPath(),
      settings: {
        font_family,
        editor_padding,
        font_size,
        line_spacing,
        // Snapshot policy. The ?? fallbacks matter: until state/settingsState.js
        // grows defaults for these keys, a save fired before the init block has
        // populated them would otherwise write null -- and null round-trips to
        // None in Rust, which snapshot_due() reads as "off". Falling back here
        // keeps a half-initialized save from silently disabling snapshots.
        backup_snapshot_mode: backup_snapshot_mode ?? "quit",
        backup_snapshot_keep: backup_snapshot_keep ?? 5,
      },
    });
  } catch (err) {
    console.error("[Settings] Save failed:", err);
  }
}
