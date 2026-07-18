const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  screen,
} = require("electron");
const path = require("path");
const url = require("url");
const backend = require("./rust-backend/index.js");

// Pick the bundled 7-Zip binary for this platform. The Tauri-era binaries keep
// their target-triple suffix, so select by platform rather than renaming.
function sevenzipPath() {
  const dir = path.join(__dirname, "bin");
  if (process.platform === "win32") {
    return path.join(dir, "7zzs-x86_64-pc-windows-msvc.exe");
  }
  if (process.platform === "darwin") {
    return path.join(dir, "7zzs-aarch64-apple-darwin");
  }
  return path.join(dir, "7zzs-x86_64-unknown-linux-gnu");
}
process.env.SEVENZIP_PATH = sevenzipPath();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow = null;

// ── Window corner squaring ───────────────────────────────────────────────────
// Goal: square the CSS corners whenever the window is flush against screen
// edges (maximized, fullscreen, or edge-tiled), rounded otherwise.
//
// Position/snap-state reliability differs by platform, so detection itself
// branches:
//   - win32: BrowserWindow.isSnapped() (Electron 36+) reports Aero Snap
//     directly from the OS, and getBounds() is always accurate. No
//     heuristics needed.
//   - darwin: getBounds() is always accurate, and macOS window tiling
//     resizes to exact half/full work-area sizes just like maximize always
//     has, so the same tiled-size match works, driven by trustworthy bounds.
//   - everything else (Linux, X11 and Wayland alike): Wayland deliberately
//     hides a client's absolute position (electron/electron#40886), and the
//     xdg_toplevel tiled_* flags Mutter sends are consumed inside
//     Chromium's Ozone layer without reaching JS (electron/electron#48357,
//     open feature request). Window *size* is still delivered reliably
//     though, and GNOME edge tiling always resizes to exactly the work
//     area, a half, or a quarter of it — so matching size against those
//     targets stands in for the missing tiled flags. X11 shares this branch
//     too: it could use real position instead, but the heuristic is
//     harmless there and keeps one code path for all of Linux rather than a
//     three-way platform split.
let lastSquared = null;

// Last known bounds while NOT tiled/maximized/fullscreen. Only consulted on
// the Linux branch (see boundsMatchTiled); unused on win32/darwin, where
// isSnapped()/getBounds() are trusted directly every time.
let lastFreeBounds = null;
let restoringBounds = false; // reentrancy guard, see updateSquaredState

// Whether the CSS drag-region titlebar is currently pressed. Only ever set
// true on Linux (see "Round while grabbing the titlebar" below); win32's
// live isSnapped() and darwin's live getBounds() track a drag correctly on
// their own, so this workaround is unnecessary — and a no-op — there.
let titlebarPressed = false;

function boundsMatchTiled(bounds) {
  const TOL = 2; // integer rounding at fractional scale factors
  const near = (a, b) => Math.abs(a - b) <= TOL;
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    const fullW = near(bounds.width, wa.width);
    const halfW = near(bounds.width, wa.width / 2);
    const fullH = near(bounds.height, wa.height);
    const halfH = near(bounds.height, wa.height / 2);
    if (
      (fullW && fullH) || // maximize-sized tile
      (halfW && fullH) || // left/right half (Super+Left/Right)
      (fullW && halfH) || // top/bottom half (extensions / other WMs)
      (halfW && halfH) //   quarter / corner tile (extensions)
    ) {
      return true;
    }
  }
  return false;
}

function computeSquared() {
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return true;

  if (process.platform === "win32") {
    // isSnapped() landed in Electron 36 (electron/electron#46079); fall back
    // to the size heuristic on older Electron just in case.
    return typeof mainWindow.isSnapped === "function"
      ? mainWindow.isSnapped()
      : boundsMatchTiled(mainWindow.getBounds());
  }

  // darwin and Linux both fall through to the bounds-matching heuristic:
  // darwin because its bounds are trustworthy and happen to fit the same
  // tiled-size pattern as Linux's untrusted-position workaround needs.
  return boundsMatchTiled(mainWindow.getBounds());
}

function updateSquaredState(force = false) {
  if (!mainWindow || restoringBounds) return;
  const squared = computeSquared();
  const wasSquared = lastSquared;

  if (!squared) {
    // Frameless BrowserWindows have a long-standing Electron bug where
    // unmaximizing (or the OS un-tiling a snapped window, e.g. by dragging
    // it) doesn't restore the pre-maximize size — it can snap back to
    // whatever size was passed to the constructor instead, because a
    // frameless window has no native chrome for the OS to track the
    // "restore size" against (electron/electron#22440, a reappearing issue
    // also filed as #13533, #2498, #7951, #15702). We work around it
    // ourselves: the instant we transition OUT of squared, force the bounds
    // back to whatever we last saw while genuinely un-squared, correcting
    // the bad auto-restore in the same tick before it's visible.
    //
    // Linux/Wayland exception: Wayland deliberately hides a client's
    // absolute window position from it (electron/electron#40886), so
    // getBounds().x/y on Linux is not the window's real screen position —
    // it can silently change (observed jumping from a real prior value to
    // {x:0, y:0}) without the window having actually moved, or vice versa.
    // Calling setBounds() with that untrusted position "restores" the
    // window to a bogus location instead of its real one, which is worse
    // than the bug this workaround was meant to fix. Skip the position
    // restore on Linux and only defer to it on win32/darwin, where bounds
    // are trustworthy (per computeSquared's own platform comment above).
    if (wasSquared && lastFreeBounds && process.platform !== "linux") {
      // setBounds below can synchronously re-emit "resize", which would
      // re-enter this function; the guard makes that re-entrant call a
      // no-op instead of looping. We deliberately do NOT touch lastSquared
      // here — the push to the renderer still happens once, below, after
      // this block, using the up-to-date `squared` value.
      restoringBounds = true;
      mainWindow.setBounds(lastFreeBounds);
      restoringBounds = false;
    } else if (process.platform !== "linux") {
      lastFreeBounds = mainWindow.getBounds();
    }
  }

  // While the Linux titlebar workaround is holding the titlebar "pressed",
  // it owns what the renderer sees (forced-rounded); don't let a
  // resize/maximize event racing in during the press overwrite that with
  // the real (possibly still-tiled) state. `force` is how
  // setTitlebarPressed itself asks for the real state on release, bypassing
  // this guard. titlebarPressed is only ever true on Linux, so this branch
  // never triggers on win32/darwin.
  if (titlebarPressed && !force) {
    lastSquared = squared;
    return;
  }

  if (squared === lastSquared) return;
  lastSquared = squared;
  mainWindow.webContents.send("window-squared-changed", squared);
}

// ── Round while grabbing the titlebar (Linux only) ──────────────────────────
// GNOME normally restores a tiled/maximized window's rounded corners the
// moment you start dragging it by the titlebar. That relies on Mutter seeing
// the drag, which requires a real OS-managed titlebar; this window's drag
// region is CSS `-webkit-app-region: drag`, and dragging it hands the move
// straight to Wayland's xdg_toplevel::move with no signal back to Electron
// that a move began (electron/electron#50133 — even a Wayland-protocol MITM
// hook to catch this is reported unstable across versions, so we
// deliberately don't attempt that here). win32 and darwin don't need this
// workaround: isSnapped() and getBounds() stay accurate live during a drag,
// so updateSquaredState's normal resize/move-driven path already tracks the
// drag correctly there without any extra signal from the renderer.
//
// What IS reliable on Linux: mousedown/mouseup on the drag region always
// reaches the renderer BEFORE the OS-level move takes over (app-region only
// intercepts the drag gesture itself, not the initial press — the existing
// ".window-controls" mousedown handler already depends on this). So the
// renderer tells main "the handle is pressed" and main forces rounded
// corners for the duration of the press, then reconciles with the real
// state on release. This intentionally rounds corners on a plain
// click-no-drag too (can't distinguish a click from a drag-that-didn't-move
// without position data) — accepted as a minor cosmetic blip in exchange
// for a mechanism that actually fires on Wayland every time.
function setTitlebarPressed(pressed) {
  if (process.platform !== "linux") return; // no-op elsewhere, see above
  titlebarPressed = pressed;
  if (!mainWindow) return;
  if (pressed) {
    mainWindow.webContents.send("window-squared-changed", false);
  } else {
    // Release: recompute and push the real state (handles both "was a real
    // drag that untiled" and "was just a click, still tiled").
    updateSquaredState(true);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    transparent: true,
    resizable: true, // frameless: edge/corner resizing handled by the OS
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile("src/index.html");
  //mainWindow.webContents.openDevTools(); // 디버깅 필요할 때만

  // Safety net: if any http(s) link tries to open a new window or navigate the
  // app frame away, send it to the system default browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (/^https?:\/\//i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Forward OS-level focus state to the renderer. document.hasFocus() in the
  // renderer can read stale on launch, so the window's real focus state is the
  // source of truth for the active/inactive (saturation) styling.
  mainWindow.on("focus", () => {
    mainWindow?.webContents.send("window-focus-changed", true);
  });
  mainWindow.on("blur", () => {
    mainWindow?.webContents.send("window-focus-changed", false);
  });
  // Send the correct initial state once the page is ready.
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.send(
      "window-focus-changed",
      mainWindow.isFocused(),
    );
    // Re-send the squared state unconditionally on (re)load: the renderer's
    // listener set is fresh, so the dedup cache must not swallow the push.
    lastSquared = null;
    updateSquaredState();
  });

  // Corner squaring inputs. "resize" fires per-frame during interactive
  // resizes; updateSquaredState is cheap and only sends on actual change.
  // Wrapped in an arrow so the Electron event-callback args (e.g. the
  // Event object "resize" passes) never leak into updateSquaredState's
  // `force` parameter.
  for (const ev of [
    "resize",
    "maximize",
    "unmaximize",
    "restore",
    "enter-full-screen",
    "leave-full-screen",
  ]) {
    mainWindow.on(ev, () => updateSquaredState());
  }

  // Safety net: if the window loses focus while the titlebar is still
  // marked "pressed" (e.g. the mouseup happened outside the window, or the
  // renderer's listener didn't get a chance to fire), don't leave the
  // corners force-rounded forever — reconcile with the real state.
  mainWindow.on("blur", () => {
    if (titlebarPressed) setTitlebarPressed(false);
  });
}

app.whenReady().then(() => {
  protocol.handle("local-media", (request) => {
    let filePath = request.url.replace(/^local-media:\/\//i, "");
    let decodedPath = decodeURIComponent(filePath);

    if (process.platform === "win32") {
      if (/^\/[a-zA-Z]:/.test(decodedPath)) {
        decodedPath = decodedPath.slice(1);
      }
    } else {
      if (!decodedPath.startsWith("/")) {
        decodedPath = "/" + decodedPath;
      }
    }

    return net.fetch(url.pathToFileURL(decodedPath).toString());
  });

  createWindow();

  // Work areas move when panels/docks/monitors change; retest the tile match.
  screen.on("display-metrics-changed", updateSquaredState);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Window controls (custom titlebar, frame:false) ──────────────────────────
ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-close", () => mainWindow?.close());
ipcMain.on("window-maximize", () => mainWindow?.maximize());
ipcMain.on("window-unmaximize", () => mainWindow?.unmaximize());
ipcMain.on("window-toggle-maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

// Renderer reports titlebar mousedown/mouseup so main can force rounded
// corners for the duration of the press (see setTitlebarPressed above).
ipcMain.on("titlebar-pressed", (_e, pressed) => {
  setTitlebarPressed(!!pressed);
});

// ── File-open dialog (custom font picker, etc.) ─────────────────────────────
// Mirrors Tauri's dialog.open: returns a single path string, or null if
// canceled. Tauri and Electron share the { name, extensions } filter shape.
ipcMain.handle("dialog-open", async (_e, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: (options && options.filters) || [],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── Vault folder picker ─────────────────────────────────────────────────────
// Used when the default vault location can't be written to (Windows
// Controlled Folder Access, a redirected/broken Documents folder, corporate
// policy), and from Settings when the user wants to move the vault. Returns a
// forward-slash path to match what the Rust side hands back, or null if
// canceled. "createDirectory" lets the user make a new folder from inside the
// dialog instead of having to bail out and use Explorer first.
ipcMain.handle("pick-vault-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder for your notes",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0].replace(/\\/g, "/");
});

// ── File watcher ────────────────────────────────────────────────────────────
// The renderer requests the watcher once it knows the vault path. The native
// watcher invokes our callback on debounced changes; we forward that to the
// renderer as "vault-changed" (the event tauri-api.js already listens for).
let watcherStarted = false;
ipcMain.on("start-vault-watcher", (_e, vaultPath) => {
  if (watcherStarted || !vaultPath) return;
  watcherStarted = true;
  try {
    backend.startVaultWatcher(vaultPath, () => {
      mainWindow?.webContents.send("vault-changed");
    });
  } catch (err) {
    console.log("[watcher] start failed:", (err && err.message) || err);
  }
});
