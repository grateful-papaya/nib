import { dialog } from "./electron-api.js";
import {
  updateDropdownValue,
  applyFontFamily,
  injectFontFace,
  addFontDropdownOption,
} from "./utils.js";
import { saveAllSettings } from "./settingsService.js";
import { setSetting } from "./state/settingsState.js";
import { hideAllScrollbarsInstantly } from "./scrollbar.js";

/**
 * Settings panel: open button and menu-tab switching.
 *
 * All other settings behavior (loading values, sliders, backup toggles, the
 * cloud-provider dropdown, persistence on change/close) lives in app.js so there
 * is a single owner for each handler. This file only covers what is unique to
 * the panel chrome plus the font dropdown.
 */
export function initSettingsPanel() {
  // Open the settings overlay.
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    const overlay = document.getElementById("settings-view");
    if (!overlay) return;
    overlay.classList.add("visible");
    hideAllScrollbarsInstantly();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector(".window")?.classList.add("settings-active");
      });
    });
  });

  // Menu tab switching.
  const menuItems = document.querySelectorAll(".settings-menu li");
  const settingsPanels = document.querySelectorAll(".settings-panel");

  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      menuItems.forEach((m) => m.classList.remove("active"));
      settingsPanels.forEach((p) => p.classList.remove("active"));
      item.classList.add("active");

      const targetPanel = document.getElementById(
        item.getAttribute("data-target"),
      );
      targetPanel?.classList.add("active");
    });
  });
}

/**
 * Mark the current choice in a dropdown list. Hover highlighting itself is
 * plain CSS (.dropdown-item:hover in settings.css); this only keeps the
 * selected row flagged so it can be styled differently from the rest.
 */
function markSelected(listEl, dropdownSelected) {
  const value = dropdownSelected.getAttribute("data-value");
  const active = listEl.querySelector(`.dropdown-item[data-value="${value}"]`);
  listEl.querySelectorAll(".dropdown-item").forEach((el) => {
    el.classList.toggle("selected", el === active);
  });
  return active;
}

/**
 * Initialize the font dropdown.
 */
export function initFontDropdown(dropdownList, dropdownSelected) {
  const dropdown = document.getElementById("font-dropdown");
  if (!dropdown || !dropdownSelected || !dropdownList) return;

  markSelected(dropdownList, dropdownSelected);

  dropdownSelected.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
    if (dropdown.classList.contains("open")) {
      markSelected(dropdownList, dropdownSelected);
    }
  });
  document.addEventListener("click", () => {
    dropdown.classList.remove("open");
  });

  dropdownList.addEventListener("click", async (e) => {
    const item = e.target.closest(".dropdown-item");
    if (!item) return;

    const value = item.getAttribute("data-value");
    dropdown.classList.remove("open");

    if (value === "font-select") {
      await handleCustomFontSelect(dropdownSelected, dropdownList);
      markSelected(dropdownList, dropdownSelected);
      return;
    }

    updateDropdownValue(value, dropdownSelected);
    applyFontFamily(value);
    setSetting("font_family", value);
    saveAllSettings();
    markSelected(dropdownList, dropdownSelected);
  });
}

async function handleCustomFontSelect(dropdownSelected, dropdownList) {
  try {
    const selectedPath = await dialog.open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Font Files", extensions: ["ttf", "otf", "woff", "woff2"] },
      ],
    });

    if (!selectedPath) {
      const fallback =
        dropdownSelected?.getAttribute("data-value") || "pretendard";
      updateDropdownValue(fallback, dropdownSelected);
      return;
    }

    const fileName = selectedPath.split("/").pop();
    const fontName = fileName.replace(/\.[^.]+$/, "");

    const localPath = await api.saveFontByPath({
      sourcePath: selectedPath,
      fileName,
    });

    const assetUrl = api.convertFileSrc(localPath);

    injectFontFace(fontName, assetUrl);
    addFontDropdownOption(fontName, dropdownList);
    updateDropdownValue(fontName, dropdownSelected);
    applyFontFamily(fontName);
    setSetting("font_family", fontName);
    saveAllSettings();
  } catch (err) {
    console.error("Font selection or save failed:", err);
    const fallback =
      dropdownSelected?.getAttribute("data-value") || "pretendard";
    updateDropdownValue(fallback, dropdownSelected);
  }
}
