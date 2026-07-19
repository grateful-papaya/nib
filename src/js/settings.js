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
 * Sliding hover highlight for dropdown lists. One pill element follows the
 * cursor from row to row (settings.css .dropdown-hover-pill) instead of each
 * row flashing its own background. Entering the list places the pill
 * instantly (.no-motion suppresses the top/height transition for one frame);
 * moving between rows then animates. Uses delegation, so options added later
 * (custom fonts) are covered automatically. Returns a hide() used when the
 * dropdown closes without the pointer leaving the list.
 */
function attachSlidingHover(listEl, dropdownSelected) {
  const pill = document.createElement("li");
  pill.className = "dropdown-hover-pill";
  pill.setAttribute("aria-hidden", "true");
  listEl.prepend(pill);

  // Move the pill onto an item. `instant` suppresses the top/height
  // transition for one frame, used when the list first opens so the pill is
  // already sitting on the selected row instead of flying in from y=0.
  const moveTo = (item, instant) => {
    if (instant) pill.classList.add("no-motion");
    pill.style.top = `${item.offsetTop}px`;
    pill.style.height = `${item.offsetHeight}px`;
    if (instant) {
      void pill.offsetHeight; // flush before re-enabling the transition
      pill.classList.remove("no-motion");
    }
    pill.classList.add("visible");
  };

  const currentItem = () => {
    const value = dropdownSelected.getAttribute("data-value");
    return listEl.querySelector(`.dropdown-item[data-value="${value}"]`);
  };

  // Mark the active option so it stays highlighted (bold text) even while
  // the pill is off hovering another row.
  const markSelected = () => {
    const active = currentItem();
    listEl.querySelectorAll(".dropdown-item").forEach((el) => {
      el.classList.toggle("selected", el === active);
    });
    return active;
  };

  // Park the pill on the selected option. This is the resting state, so the
  // hover highlight always grows out of (and returns to) the current choice
  // rather than appearing from nowhere.
  const settle = (instant) => {
    const active = markSelected();
    if (active) moveTo(active, instant);
    else pill.classList.remove("visible");
  };

  const hide = () => pill.classList.remove("visible");

  listEl.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".dropdown-item");
    if (item && listEl.contains(item)) moveTo(item, false);
  });

  listEl.addEventListener("mouseleave", () => settle(false));

  return { settle, hide, mark: markSelected };
}

/**
 * Initialize the font dropdown.
 */
export function initFontDropdown(dropdownList, dropdownSelected) {
  const dropdown = document.getElementById("font-dropdown");
  if (!dropdown || !dropdownSelected || !dropdownList) return;

  const hoverPill = attachSlidingHover(dropdownList, dropdownSelected);

  dropdownSelected.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
    // Opening: place the pill on the current choice with no animation.
    // Closing: drop it, so the next open starts clean.
    if (dropdown.classList.contains("open")) hoverPill.settle(true);
    else hoverPill.hide();
  });
  document.addEventListener("click", () => {
    dropdown.classList.remove("open");
    hoverPill.hide();
  });

  dropdownList.addEventListener("click", async (e) => {
    const item = e.target.closest(".dropdown-item");
    if (!item) return;

    const value = item.getAttribute("data-value");
    dropdown.classList.remove("open");
    hoverPill.hide();

    if (value === "font-select") {
      await handleCustomFontSelect(dropdownSelected, dropdownList);
      hoverPill.mark();
      return;
    }

    updateDropdownValue(value, dropdownSelected);
    applyFontFamily(value);
    setSetting("font_family", value);
    saveAllSettings();
    // Re-mark so the new choice is bold the next time the list opens. mark()
    // rather than settle() -- the list is closed here, so the pill should
    // stay hidden until the next open.
    hoverPill.mark();
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
