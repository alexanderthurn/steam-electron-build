const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const pkg = require('../package.json');
const STEAM_APP_ID = Number(process.env.STEAM_APP_ID) || pkg.steamAppId;

// ── Linux: fix library search path before any native modules load ─────────────
// Steam sets LD_LIBRARY_PATH to its own dirs, which contain an older
// libsteam_api.so that may be missing symbols steamworks.js requires.
// glibc re-reads LD_LIBRARY_PATH on each dlopen(), so prepending here (before
// require('steamworks.js') below) ensures the bundled version wins.
if (process.platform === 'linux') {
    const swLibDir = path.join(process.resourcesPath, 'app.asar.unpacked',
        'node_modules', 'steamworks.js', 'dist', 'linux64');
    const appDir = path.dirname(process.execPath);
    const existing = process.env.LD_LIBRARY_PATH || '';
    process.env.LD_LIBRARY_PATH = [swLibDir, appDir, existing].filter(Boolean).join(':');

    // Required for Steam Linux runtime: sandbox and zygote process model fail there.
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-dev-shm-usage'); // use /tmp instead of /dev/shm
    app.commandLine.appendSwitch('no-zygote');             // prevents ESRCH zygote failures
}

// ── Steam ─────────────────────────────────────────────────────────────────────

let steam = null;  // steamworks.js client
let sw    = null;  // steamworks.js module

function initSteam() {
    try {
        sw = require('steamworks.js');
    } catch (e) {
        console.warn('[Steam] Load failed:', e.message);
        return;
    }

    // Overlay hook is non-critical — never let it block Steam init.
    // On Linux the Steam overlay is injected by Steam itself; this call
    // only matters on Windows/Mac and may throw in some packaged environments.
    try {
        sw.electronEnableSteamOverlay();
    } catch (e) {
        console.warn('[Steam] Overlay hook failed (non-fatal):', e.message);
    }

    try {
        steam = sw.init(STEAM_APP_ID);
        console.log('[Steam] Initialized:', steam.localplayer.getName());
    } catch (e) {
        console.warn('[Steam] Init failed:', e.message);
    }
}

// ── Storage ───────────────────────────────────────────────────────────────────

function getSavePath() {
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'save.json');
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWin = null;

function createWindow() {
    // Packaged mac/win builds get their icon from the bundle/exe; this path
    // only exists in dev and in packaged Linux builds (extraResources).
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(__dirname, '../build/icon.png');
    mainWin = new BrowserWindow({
        width: 1280,
        height: 720,
        center: true,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWin.removeMenu();

    mainWin.loadFile(path.join(__dirname, '../dist/index.html'));

    const safeSend = (ch) => { if (!mainWin?.isDestroyed()) mainWin.webContents.send(ch); };
    mainWin.on('move',   () => safeSend('win:moved'));
    mainWin.on('resize', () => safeSend('win:resized'));
    mainWin.on('closed', () => { mainWin = null; });
}

app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged) {
        app.dock.setIcon(path.join(__dirname, '../build/icon.png'));
    }
    initSteam();
    createWindow();
});
app.on('window-all-closed', () => {
    app.quit();
    // On Linux, Electron leaves crashpad_handler and other subprocesses running,
    // which prevents Steam from detecting the game as exited. Force a clean exit.
    if (process.platform === 'linux') setTimeout(() => process.exit(0), 300);
});

// ── IPC: Steam ────────────────────────────────────────────────────────────────

ipcMain.handle('steam:getUserName', () =>
    steam?.localplayer.getName() ?? '');

ipcMain.handle('steam:getSteamId', () => {
    const id = steam?.localplayer.getSteamId();
    return id ? String(id.steamId64 ?? id) : '0';
});

ipcMain.handle('steam:getAppId', () =>
    steam?.utils.getAppId() ?? 0);

ipcMain.handle('steam:isDev', () =>
    !app.isPackaged);

ipcMain.handle('steam:quit', () =>
    app.quit());

ipcMain.handle('steam:activateOverlay', (_e, dialog) => {
    if (!steam) return;
    const dlg = steam.overlay.Dialog[dialog] ?? steam.overlay.Dialog.Friends;
    steam.overlay.activateDialog(dlg);
});

ipcMain.handle('steam:openStore', () => {
    if (!steam) return;
    const flag = steam.overlay.StoreFlag?.None ?? 0;
    steam.overlay.activateToStore(steam.utils.getAppId(), flag);
});

ipcMain.handle('steam:unlockAchievement', (_e, id) => {
    if (!steam) return;
    steam.achievement.activate(id);
    steam.stats.store();
});

ipcMain.handle('steam:getUnlockedAchievements', (_e, ids) => {
    if (!steam) return [];
    return ids.filter(id => steam.achievement.isActivated(id));
});

ipcMain.handle('steam:getStatI32', (_e, name) =>
    steam?.stats.getInt(name) ?? 0);

ipcMain.handle('steam:setStat', (_e, name, value) => {
    if (!steam) return;
    steam.stats.setInt(name, value);
    steam.stats.store();
});

ipcMain.handle('steam:clearAchievement', (_e, id) => {
    if (!steam) return;
    steam.achievement.clear(id);
    steam.stats.store();
});

ipcMain.handle('steam:resetAllStats', (_e, achievementsToo) => {
    if (!steam || !sw) return false;
    const ok = sw.stats.resetAll(!!achievementsToo);
    if (ok) steam.stats.store();
    return ok;
});

// ── IPC: Storage ──────────────────────────────────────────────────────────────

ipcMain.handle('storage:readAll', () => {
    const p = getSavePath();
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '{}';
});

ipcMain.handle('storage:writeAll', (_e, data) =>
    fs.writeFileSync(getSavePath(), data, 'utf8'));

ipcMain.handle('storage:getPath', () =>
    getSavePath());

// ── IPC: Window management ────────────────────────────────────────────────────

ipcMain.handle('win:close',          () => mainWin?.close());
ipcMain.handle('win:setFullscreen',  (_e, flag) => mainWin?.setFullScreen(flag));
ipcMain.handle('win:isFullscreen',   () => mainWin?.isFullScreen() ?? false);
ipcMain.handle('win:setPosition',    (_e, pos) => mainWin?.setPosition(Math.round(pos.x), Math.round(pos.y)));
ipcMain.handle('win:setSize',        (_e, sz)  => mainWin?.setSize(Math.round(sz.width), Math.round(sz.height)));
ipcMain.handle('win:outerPosition',  () => { const [x, y] = mainWin?.getPosition() ?? [0, 0]; return { x, y }; });
ipcMain.handle('win:outerSize',      () => { const [width, height] = mainWin?.getSize() ?? [800, 600]; return { width, height }; });
ipcMain.handle('win:openDevtools',   () => { if (!app.isPackaged) mainWin?.webContents.openDevTools(); });

ipcMain.handle('win:getMonitors', () =>
    screen.getAllDisplays().map(d => ({
        name: d.label || `Display ${d.id}`,
        position: { x: d.bounds.x, y: d.bounds.y },
        size: { width: d.bounds.width, height: d.bounds.height },
    })));

ipcMain.handle('win:getCurrentMonitor', () => {
    if (!mainWin) return null;
    const d = screen.getDisplayMatching(mainWin.getBounds());
    return {
        name: d.label || `Display ${d.id}`,
        position: { x: d.bounds.x, y: d.bounds.y },
        size: { width: d.bounds.width, height: d.bounds.height },
    };
});

// ── IPC: Open URL ─────────────────────────────────────────────────────────────

ipcMain.handle('openUrl', (_e, url) => shell.openExternal(url));
