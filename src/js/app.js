// js/app.js
// Entry point. Loaded as the single <script type="module"> in index.html.
//
// This file used to be ~1300 lines of managers, event wiring and formatting
// helpers. It is now only a boot sequence: everything it calls lives in
// js/app/*. The ordering constraints below are the reason this stayed a
// hand-written sequence rather than a list of init functions in a loop.

import {
  applyFontFamily,
  updateDropdownValue,
  addFontDropdownOption,
  applyEditorPadding,
} from "./utils.js";
import { refreshFileTree, initTreeHover } from "./file-tree.js";
import { initSidebarContextMenu, initSidebarAddButtons } from "./sidebar.js";
import { initTitlebarSearch } from "./titlebar-search.js";
import { initSidebarViews } from "./sidebarViews.js";
import { initSettingsPanel, initFontDropdown } from "./settings.js";
import { initSidebarResizer } from "./resize.js";
import { initRawSourceTooltip } from "./raw-tooltip.js";
import { initPathInfo } from "./path-info.js";
import { invalidateTagList } from "./tag-search.js";
import { initCustomScrollbars } from "./scrollbar.js";
import { getVaultPath } from "./state/appState.js";
import { getSetting, setSetting } from "./state/settingsState.js";

import { byId, findTreeFileLabel } from "./app/dom.js";
import { resolveVaultPath } from "./app/vault.js";
import { LAST_OPENED_FILE_KEY } from "./app/persistence.js";
import {
  applyEditorFontSize,
  applyEditorLineSpacing,
  syncSlidersFromSettings,
  setSnapshotModeUI,
  initSettingsBindings,
  initRestorePanel,
} from "./app/settingsPanel.js";
import {
  initElasticScroll,
  initReadingModeToggle,
  initLinks,
} from "./app/editorSurface.js";
import {
  suppressEmptyContextMenu,
  initWindowChrome,
  initShortcuts,
  initDocumentActions,
} from "./app/chrome.js";
import { initFileHoverTooltip } from "./app/fileMetaTooltip.js";

// Re-exported for modules that imported them from app.js before the split.
export {
  VAULT_PATH_KEY,
  resolveVaultPath,
  changeVaultLocation,
} from "./app/vault.js";

const DEFAULT_FONT = "pretendard";
const BUILT_IN_FONTS = new Set([DEFAULT_FONT, "system"]);

/**
 * Copy the on-disk settings into settingsState, falling back to the defaults
 * already declared there rather than re-declaring them here. The old code
 * carried a second copy of every default as a local `saved*` variable, so the
 * two could (and did) drift.
 *
 * @param {Record<string, unknown>} loaded
 */
function adoptLoadedSettings(loaded) {
  for (const key of [
    "font_size",
    "editor_padding",
    "line_spacing",
    "font_family",
  ]) {
    if (loaded[key]) setSetting(key, loaded[key]);
  }

  // "days" is the retired interval mode; treat it as "daily" on the way in.
  const mode = loaded.backup_snapshot_mode || "quit";
  setSetting("backup_snapshot_mode", mode === "days" ? "daily" : mode);
  setSetting("backup_snapshot_keep", loaded.backup_snapshot_keep ?? 5);
}

/** Push settingsState into the DOM. Runs whether or not loading succeeded. */
function applySettingsToUI(dropdownList, dropdownSelected) {
  const font = getSetting("font_family");
  if (!BUILT_IN_FONTS.has(font)) addFontDropdownOption(font, dropdownList);
  updateDropdownValue(font, dropdownSelected);
  applyFontFamily(font);

  applyEditorPadding(getSetting("editor_padding"));
  applyEditorFontSize(getSetting("font_size"));
  applyEditorLineSpacing(getSetting("line_spacing"));
  syncSlidersFromSettings();

  setSnapshotModeUI(getSetting("backup_snapshot_mode"));
  const keepInput = byId("snapshot-keep-input");
  if (keepInput) keepInput.value = getSetting("backup_snapshot_keep");
}

/** Re-open whatever was on screen last session. */
function restoreLastOpenedFile() {
  const path = localStorage.getItem(LAST_OPENED_FILE_KEY);
  if (!path) return;
  // The tree has just been built; wait for it to paint before clicking.
  requestAnimationFrame(() => findTreeFileLabel(path)?.click());
}

/**
 * @param {HTMLElement|null} dropdownList
 * @param {HTMLElement|null} dropdownSelected
 */
async function initApp(dropdownList, dropdownSelected) {
  // Note: no early return when this fails. The vault is only one of the
  // things initApp sets up — bailing here would also skip the font, padding
  // and scrollbar setup below, leaving a half-rendered window. Better to show
  // an empty but correct UI and let the user fix the folder from Settings.
  const vaultOk = await resolveVaultPath();

  if (vaultOk) {
    try {
      window.api?.startVaultWatcher?.(getVaultPath());
      adoptLoadedSettings(
        (await api.loadSettings({ vaultPath: getVaultPath() })) || {},
      );
    } catch (err) {
      console.error("[Init] Load failed:", err);
    }

    try {
      await refreshFileTree();
      restoreLastOpenedFile();
    } catch (err) {
      console.error("[Init] File tree failed:", err);
    }
  }

  applySettingsToUI(dropdownList, dropdownSelected);
  initCustomScrollbars();
}

window.addEventListener("DOMContentLoaded", async () => {
  window.focus();

  // First, and in the capture phase — see the comment on the function.
  suppressEmptyContextMenu();

  const dropdown = byId("font-dropdown");
  const dropdownSelected = byId("dropdown-selected-val");
  const dropdownList = dropdown?.querySelector(".dropdown-list") ?? null;

  // Before initApp: restores the saved sidebar state (open/closed, width, and
  // which panel — tree or outline — is on top) without animation, and binds
  // the menu button's cycle/right-click/hover-popup behavior.
  initSidebarViews();

  await initApp(dropdownList, dropdownSelected);

  initSidebarContextMenu();
  initSidebarAddButtons();
  initTreeHover();
  initTitlebarSearch();
  // After initTitlebarSearch: the info popover hands tag queries to the search
  // bar via a window event, and the bar has to be listening before a click can
  // reach it.
  initPathInfo();
  await initSettingsPanel();
  initFontDropdown(dropdownList, dropdownSelected);
  initSidebarResizer();

  initElasticScroll();
  initFileHoverTooltip();
  initRawSourceTooltip();

  initWindowChrome();
  initReadingModeToggle();
  initDocumentActions();
  initSettingsBindings();
  initRestorePanel();
  initShortcuts();
  initLinks();

  // Vault-change watcher (kept here rather than in electron-api.js so that
  // file stays a dependency-free leaf).
  window.api.onVaultChange(() => {
    refreshFileTree();
    // External edits (git pull, another editor, a sync client) can add or
    // remove tags. Dropping the cached tag list makes the next autocomplete
    // re-fetch; the Rust index behind it is incremental, so this only
    // reparses the files whose mtime actually moved.
    invalidateTagList();
  });
});
