// ─── Font Management ────────────────────────────────────────────────────────
const FontManager = (() => {
  const customFontElement = document.createElement("style");
  customFontElement.id = "dynamic-font-style";
  document.head.appendChild(customFontElement);

  // Track injected fonts to avoid duplicate @font-face insertion.
  const injectedFonts = new Set();

  return {
    applyFontFamily: (fontName) => {
      const fonts = {
        pretendard: '"Pretendard", sans-serif',
        system: "system-ui, sans-serif",
      };
      document.body.style.fontFamily =
        fonts[fontName] || `"${fontName}", "Pretendard", sans-serif`;
    },

    updateDropdownValue: (value, dropdownSelected) => {
      if (!dropdownSelected) return;
      dropdownSelected.setAttribute("data-value", value);

      const displayNames = {
        pretendard: "Pretendard",
        system: "System",
      };

      // Update only the label span's text, not the whole element's
      // textContent — dropdownSelected also holds the arrow icon <img>
      // as a sibling, which a full textContent overwrite would delete.
      const label = dropdownSelected.querySelector(".dropdown-selected-label");
      const text = displayNames[value] || value;
      if (label) {
        label.textContent = text;
      } else {
        dropdownSelected.textContent = text;
      }
    },

    addDropdownOption: (fontName, dropdownList) => {
      if (
        !dropdownList ||
        dropdownList.querySelector(`.dropdown-item[data-value="${fontName}"]`)
      )
        return;

      const item = document.createElement("li");
      item.className = "dropdown-item";
      item.setAttribute("data-value", fontName);
      item.textContent = fontName;

      dropdownList.insertBefore(item, dropdownList.lastElementChild);
    },

    // Dedupe, then insert the rule via CSSOM.
    injectFontFace: (name, url) => {
      // 1. Skip if already registered (prevents accumulating leftover text).
      if (injectedFonts.has(name)) return;

      const rule = `@font-face { font-family: "${name}"; src: url("${url}"); }`;

      // 2. Insert via CSSOM, with a fallback if the stylesheet isn't ready yet.
      if (customFontElement.sheet) {
        customFontElement.sheet.insertRule(
          rule,
          customFontElement.sheet.cssRules.length,
        );
      } else {
        customFontElement.textContent += `\n${rule}`;
      }

      // 3. Record it as injected.
      injectedFonts.add(name);
    },
  };
})();

// ─── Toast Notifications ────────────────────────────────────────────────────
const ToastManager = (() => {
  let toastTimeout;
  let toast = null;

  const getToast = () =>
    toast || (toast = document.getElementById("apply-toast"));

  const hideToast = () => {
    clearTimeout(toastTimeout);
    getToast()?.classList.remove("show");
  };

  return {
    show: (message) => {
      const el = getToast();
      if (!el) return;

      hideToast();
      el.textContent = message;
      el.classList.add("show");
      toastTimeout = setTimeout(hideToast, 2500);
    },

    showWithAction: (message, actionLabel, onAction, duration = 5000) => {
      const el = getToast();
      if (!el) return;

      hideToast();
      el.textContent = "";

      const msg = document.createElement("span");
      msg.textContent = message;

      const btn = document.createElement("button");
      btn.className = "toast-action-btn";
      btn.textContent = actionLabel;
      btn.addEventListener("click", () => {
        hideToast();
        try {
          onAction();
        } catch (_) {}
      });

      el.append(msg, btn);
      el.classList.add("show");
      toastTimeout = setTimeout(hideToast, duration);
    },
  };
})();

// ─── Editor UI & Indicators ─────────────────────────────────────────────────
const EditorUIManager = (() => {
  // Pending phase timers of the current save animation. Without clearing
  // them, a save landing while the previous indicator is still up (rapid
  // Ctrl+S / autosave) lets the OLD run's 2s timeout hide the NEW run's
  // animation mid-flight.
  let phaseTimer = null;
  let hideTimer = null;

  return {
    applyPadding: (paddingValue) => {
      document.documentElement.style.setProperty(
        "--editor-padding",
        `${paddingValue}%`,
      );
    },

    showSaveIndicator: () => {
      const el = document.getElementById("save-indicator");
      const ring = el?.querySelector(".save-ring");
      const check = el?.querySelector(".save-check");

      if (!el || !ring || !check) return;

      clearTimeout(phaseTimer);
      clearTimeout(hideTimer);

      // Reset instantly, with transitions suppressed. `.hidden` collapses via
      // max-width now (the element STAYS rendered so the search bar can
      // resize smoothly), which changes the rules from the display:none era:
      // the previous run's inline styles (dashoffset 0, check visible) are
      // still live in the render tree, so an unsuppressed reset would visibly
      // animate the ring BACKWARD, and pairing the reset with the 0-target in
      // the same style recalc (the old rAF approach) lets the browser coalesce
      // 63 -> 0 into "no change" — which is exactly the no-animation bug.
      ring.style.transition = "none";
      check.style.transition = "none";
      ring.style.strokeDashoffset = "63";
      ring.style.opacity = "1";
      check.style.opacity = "0";
      el.classList.remove("hidden");

      // Force a synchronous style flush so the reset state is committed as
      // the transition's starting point, then re-enable transitions and set
      // the target — the ring draws 63 -> 0 via the CSS transition.
      void el.offsetWidth;
      ring.style.transition = "";
      check.style.transition = "";
      ring.style.strokeDashoffset = "0";

      // Ring -> checkmark, then collapse away.
      phaseTimer = setTimeout(() => {
        ring.style.opacity = "0";
        check.style.opacity = "1";
      }, 400);

      hideTimer = setTimeout(() => {
        el.classList.add("hidden");
        ring.style.opacity = "1";
      }, 2000);
    },
  };
})();

// ─── Custom Confirm Dialog ──────────────────────────────────────────────────
const DialogManager = (() => {
  let activeConfirmCancel = null;

  return {
    showConfirm: (title, message, okText = "Confirm") => {
      return new Promise((resolve) => {
        const overlay = document.getElementById("custom-confirm-overlay");
        const titleEl = document.getElementById("confirm-title");
        const messageEl = document.getElementById("confirm-message");
        const okBtn = document.getElementById("confirm-ok-btn");
        const cancelBtn = document.getElementById("confirm-cancel-btn");

        if (!overlay || !titleEl || !messageEl || !okBtn || !cancelBtn) {
          return resolve(window.confirm(message));
        }

        if (activeConfirmCancel) activeConfirmCancel();

        titleEl.textContent = title;
        messageEl.textContent = message;
        okBtn.textContent = okText;

        const cleanup = () => {
          okBtn.onclick = null;
          cancelBtn.onclick = null;
          overlay.onmousedown = null;
          overlay.classList.remove("visible");
          activeConfirmCancel = null;
        };

        const handleAction = (result) => {
          cleanup();
          resolve(result);
        };

        activeConfirmCancel = () => handleAction(false);

        okBtn.onclick = () => handleAction(true);
        cancelBtn.onclick = activeConfirmCancel;
        overlay.onmousedown = (e) => {
          if (e.target === overlay) handleAction(false);
        };

        overlay.classList.add("visible");
      });
    },
  };
})();

// ─── Module exports ─────────────────────────────────────────────────────────
export const showToast = ToastManager.show;
export const showToastWithAction = ToastManager.showWithAction;
export const applyFontFamily = FontManager.applyFontFamily;
export const updateDropdownValue = FontManager.updateDropdownValue;
export const addFontDropdownOption = FontManager.addDropdownOption;
export const injectFontFace = FontManager.injectFontFace;
export const applyEditorPadding = EditorUIManager.applyPadding;
export const showSaveIndicator = EditorUIManager.showSaveIndicator;
export const showCustomConfirm = DialogManager.showConfirm;
