// js/app/settingsPanel.js
// The settings overlay: typography sliders and the CSS variables they drive,
// the backup snapshot policy, and the restore tab.
//
// Grouped because they share one surface and one save path — every control in
// here ends in saveAllSettings(), and the restore list is a tab of the same
// panel. Was UIManager + the settings half of EventBinder in app.js.

import { applyEditorPadding, showToast } from "../utils.js";
import { hideAllScrollbarsInstantly } from "../scrollbar.js";
import { saveAllSettings } from "../settingsService.js";
import { setSetting, getSetting } from "../state/settingsState.js";
import { setSettingsSliderDragging } from "../state/uiState.js";
import { getVaultPath } from "../state/appState.js";
import { formatBytes, formatSnapshotName } from "./format.js";
import { saveActiveFile } from "./persistence.js";
import { byId, bySelector } from "./dom.js";

// ─── Editor appearance ────────────────────────────────────────────────────

/** @param {string|number} size px */
export function applyEditorFontSize(size) {
  byId("editor-body")?.style.setProperty("--editor-font-size", `${size}px`);
}

/** @param {string|number} spacing unitless line-height */
export function applyEditorLineSpacing(spacing) {
  byId("editor-body")?.style.setProperty("--editor-line-height", `${spacing}`);
}

/**
 * Sets --slider-fill to the value's percentage across the slider's range so
 * the custom track CSS can paint the filled portion up to the thumb. Falls
 * back to 0/100 like a native input does when the attributes are absent.
 *
 * @param {HTMLInputElement|null} slider
 */
export function updateSliderFill(slider) {
  if (!slider) return;
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 100;
  const span = max - min;
  const pct = span === 0 ? 0 : ((Number(slider.value) - min) / span) * 100;
  slider.style.setProperty("--slider-fill", `${pct}%`);
}

// ─── Sliders & snapshot policy ────────────────────────────────────────────

/**
 * One table drives both the event binding and the initial UI sync. Previously
 * the two lived apart — three bindSliderDrag() calls plus a hand-unrolled
 * initSliderUIValues() with six getElementById calls — and the unit strings
 * were duplicated between them.
 *
 * @type {ReadonlyArray<{
 *   sliderId: string, valueId: string, unit: string,
 *   settingKey: string, apply: (value: string) => void,
 * }>}
 */
const SLIDERS = [
  {
    sliderId: "editor-fontsize-slider",
    valueId: "editor-fontsize-value",
    unit: "px",
    settingKey: "font_size",
    apply: applyEditorFontSize,
  },
  {
    sliderId: "editor-linespacing-slider",
    valueId: "editor-linespacing-value",
    unit: "",
    settingKey: "line_spacing",
    apply: applyEditorLineSpacing,
  },
  {
    sliderId: "editor-padding-slider",
    valueId: "editor-padding-value",
    unit: "%",
    settingKey: "editor_padding",
    apply: applyEditorPadding,
  },
];

/**
 * Push the persisted settings values into the slider inputs, their numeric
 * labels and the custom track fill. Reads settingsState directly so callers
 * no longer thread three values through as positional arguments.
 */
export function syncSlidersFromSettings() {
  for (const { sliderId, valueId, unit, settingKey } of SLIDERS) {
    const slider = byId(sliderId);
    const label = byId(valueId);
    if (!slider) continue;

    const value = getSetting(settingKey);
    slider.value = value;
    if (label) label.textContent = `${value}${unit}`;
    updateSliderFill(slider);
  }
}

/**
 * @param {(typeof SLIDERS)[number]} config
 */
function bindSlider({ sliderId, valueId, unit, settingKey, apply }) {
  const slider = byId(sliderId);
  if (!slider) return;

  const label = byId(valueId);
  const card = slider.closest(".setting-card");
  const row = slider.closest(".setting-row");

  slider.addEventListener("input", (e) => {
    const value = e.target.value;
    if (label) label.textContent = `${value}${unit}`;
    updateSliderFill(slider);
    setSetting(settingKey, value);
    apply(value);
  });

  // Guard flag. The old code bound stopDrag to mouseleave unconditionally, so
  // merely sweeping the cursor across a slider fired saveAllSettings() — an
  // IPC round-trip plus a settings.json write — without the user ever having
  // touched it. Now a stop is only honored if a start actually happened.
  let dragging = false;

  const startDrag = () => {
    if (dragging) return;
    dragging = true;
    byId("settings-view")?.classList.add("dragging-slider");
    card?.classList.add("active-drag");
    row?.classList.add("active-row");
    setSettingsSliderDragging(true);
    hideAllScrollbarsInstantly();
  };

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    byId("settings-view")?.classList.remove("dragging-slider");
    card?.classList.remove("active-drag");
    row?.classList.remove("active-row");
    setSettingsSliderDragging(false);
    saveAllSettings();
  };

  slider.addEventListener("mousedown", startDrag);
  slider.addEventListener("touchstart", startDrag, { passive: true });
  slider.addEventListener("mouseup", stopDrag);
  slider.addEventListener("touchend", stopDrag);
  slider.addEventListener("mouseleave", stopDrag);
}

/**
 * Sync the snapshot-mode segmented control to a mode value. Setting
 * data-value on the container is what moves the thumb (settings.css keys the
 * translateX off it); the .active classes drive the label dim/scale styling.
 *
 * @param {"quit"|"daily"} mode
 */
export function setSnapshotModeUI(mode) {
  const segment = byId("snapshot-mode-segment");
  if (!segment) return;

  segment.setAttribute("data-value", mode);
  for (const btn of segment.querySelectorAll(".segment-option")) {
    btn.classList.toggle("active", btn.getAttribute("data-value") === mode);
  }
}

/**
 * Backup snapshot policy. Two settings drive .backup/snapshots/ retention
 * (see lib.rs):
 *   backup_snapshot_mode: "quit"  — a new snapshot per quit
 *                       | "daily" — one per day, last quit of the day wins
 *   backup_snapshot_keep: how many to retain; 0 disables snapshots
 */
function bindSnapshotPolicy() {
  byId("snapshot-mode-segment")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".segment-option");
    if (!btn || btn.classList.contains("active")) return;

    const mode = btn.getAttribute("data-value");
    setSnapshotModeUI(mode);
    setSetting("backup_snapshot_mode", mode);
    saveAllSettings();
  });

  byId("snapshot-keep-input")?.addEventListener("change", (e) => {
    const keep = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = keep;
    setSetting("backup_snapshot_keep", keep);
    saveAllSettings();
  });
}

/** Close button on the settings overlay. */
function bindSettingsClose() {
  bySelector(".settings-close-btn")?.addEventListener("click", () => {
    byId("settings-view")?.classList.remove("visible");
    bySelector(".window")?.classList.remove("settings-active");
    saveAllSettings();
  });
}

export function initSettingsBindings() {
  SLIDERS.forEach(bindSlider);
  bindSnapshotPolicy();
  bindSettingsClose();
}

// ─── Restore tab ──────────────────────────────────────────────────────────

const ARM_TIMEOUT_MS = 4000;

/** @type {Map<string, { name: string, path: string, size: number }>} */
const snapshotsById = new Map();
let armedButton = null;
let armTimer = null;

function disarm() {
  clearTimeout(armTimer);
  if (armedButton && armedButton.isConnected) {
    armedButton.classList.remove("armed");
    armedButton.textContent = "Restore";
  }
  armedButton = null;
}

/**
 * @param {HTMLButtonElement} btn
 */
function arm(btn) {
  disarm();
  armedButton = btn;
  btn.classList.add("armed");
  btn.textContent = "Confirm restore";
  armTimer = setTimeout(disarm, ARM_TIMEOUT_MS);
}

/**
 * @param {{ id: string, name: string, size: number }} snapshot
 * @returns {HTMLLIElement}
 */
function buildRow({ id, name, size }) {
  const li = document.createElement("li");
  li.className = "restore-item";

  const info = document.createElement("div");
  info.className = "restore-item-info";

  const title = document.createElement("span");
  title.className = "restore-item-title";
  title.textContent = formatSnapshotName(name);

  const meta = document.createElement("span");
  meta.className = "restore-item-meta";
  meta.textContent = formatBytes(size);

  info.append(title, meta);

  const btn = document.createElement("button");
  btn.className = "restore-item-btn";
  btn.textContent = "Restore";
  btn.dataset.snapshotId = id;

  li.append(info, btn);
  return li;
}

/**
 * @param {HTMLUListElement} list
 * @param {boolean} disabled
 */
function setButtonsDisabled(list, disabled) {
  for (const btn of list.querySelectorAll(".restore-item-btn")) {
    btn.disabled = disabled;
  }
}

/**
 * @param {HTMLUListElement} list
 * @param {HTMLButtonElement} btn
 */
async function performRestore(list, btn) {
  const snapshot = snapshotsById.get(btn.dataset.snapshotId);
  if (!snapshot) return;

  disarm();
  btn.textContent = "Restoring…";
  setButtonsDisabled(list, true);

  try {
    // Flush the open editor buffer first: it is part of the "current state"
    // the safety snapshot should capture, and after the swap an autosave of
    // the stale buffer would clobber a restored file.
    //
    // commitRename is off deliberately. Renaming on disk moments before the
    // tree is replaced wholesale would leave the rename applied to a vault
    // that no longer exists.
    await saveActiveFile({ commitRename: false });

    await api.restoreSnapshot({
      vaultPath: getVaultPath(),
      snapshotPath: snapshot.path,
    });

    // Everything on screen (tree, tabs, editor, pins) describes the
    // pre-restore vault; a full reload rebuilds it all from disk.
    location.reload();
  } catch (err) {
    console.error("[Restore] failed:", err?.message || err);
    showToast(`Restore failed: ${err?.message || "unknown error"}`);
    setButtonsDisabled(list, false);
    btn.textContent = "Restore";
  }
}

async function populateRestoreList() {
  const list = byId("restore-list");
  if (!list) return;

  disarm();
  snapshotsById.clear();

  let snapshots = [];
  try {
    snapshots = await api.listBackupSnapshots({ vaultPath: getVaultPath() });
  } catch (err) {
    console.error("[Restore] list failed:", err?.message || err);
  }

  if (!snapshots.length) {
    const li = document.createElement("li");
    li.className = "restore-empty";
    li.textContent =
      "No snapshots yet — quit the app once to create the first one.";
    list.replaceChildren(li);
    return;
  }

  // One fragment, one insertion. The old loop appended each <li> directly to
  // the live list, forcing a layout pass per snapshot.
  const frag = document.createDocumentFragment();
  snapshots.forEach((snapshot, index) => {
    // The archive path is the natural key, but it goes in a Map rather than a
    // data attribute so a path with quotes in it can't break the markup.
    const id = String(index);
    snapshotsById.set(id, snapshot);
    frag.append(buildRow({ id, name: snapshot.name, size: snapshot.size }));
  });
  list.replaceChildren(frag);
}

export function initRestorePanel() {
  const list = byId("restore-list");

  // One delegated listener for the whole list instead of one closure (plus
  // its own arm timer) per snapshot button, re-created on every tab open.
  list?.addEventListener("click", (e) => {
    const btn = e.target.closest(".restore-item-btn");
    if (!btn || btn.disabled) return;

    if (btn !== armedButton) arm(btn);
    else performRestore(list, btn);
  });

  // Refresh the list each time the Backup tab is opened — a quit-created
  // snapshot from a previous session should appear without restarting the
  // settings panel.
  bySelector('.settings-menu li[data-target="panel-backup"]')?.addEventListener(
    "click",
    populateRestoreList,
  );
}
