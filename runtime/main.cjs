const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
// dev:      full config passed by the CLI via env (absolute paths)
// packaged: read from the staged app's package.json "steamElectronBuild" block

const cfg = process.env.STEAM_ELECTRON_BUILD_CONFIG
    ? JSON.parse(process.env.STEAM_ELECTRON_BUILD_CONFIG)
    : require(path.join(app.getAppPath(), 'package.json')).steamElectronBuild;

const indexHtml = process.env.STEAM_ELECTRON_BUILD_CONFIG
    ? path.join(cfg.distDir, 'index.html')
    : path.join(app.getAppPath(), 'dist', 'index.html');

app.setName(cfg.productName);
// Deterministic save location (same in dev and packaged builds)
app.setPath('userData', path.join(app.getPath('appData'), cfg.appId));

// ── Linux: fix library search path before any native modules load ─────────────
// Steam sets LD_LIBRARY_PATH to its own dirs, which contain an older
// libsteam_api.so that may be missing symbols steamworks.js requires.
// glibc re-reads LD_LIBRARY_PATH on each dlopen(), so prepending here (before
// require('steamworks.js') below) ensures the bundled version wins.
if (process.platform === 'linux') {
    const dirs = [];
    if (app.isPackaged) {
        dirs.push(path.join(process.resourcesPath, 'app.asar.unpacked',
            'node_modules', 'steamworks.js', 'dist', 'linux64'));
    } else if (cfg.steamworksPath) {
        dirs.push(path.join(cfg.steamworksPath, 'dist', 'linux64'));
    }
    dirs.push(path.dirname(process.execPath));
    if (process.env.LD_LIBRARY_PATH) dirs.push(process.env.LD_LIBRARY_PATH);
    process.env.LD_LIBRARY_PATH = dirs.join(':');

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
        // dev: absolute path resolved by the CLI; packaged: staged node_modules
        sw = require(cfg.steamworksPath ?? 'steamworks.js');
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
        steam = sw.init(cfg.steamAppId);
        console.log('[Steam] Initialized:', steam.localplayer.getName());
        initNetworking();
    } catch (e) {
        console.warn('[Steam] Init failed:', e.message);
    }
}

// ── Networking (lobbies + P2P) ─────────────────────────────────────────────────
// Only ever called right after a successful sw.init() above — everything
// here assumes `steam` is set.

let currentLobby = null;  // steamworks.js Lobby handle — held here so IPC
                           // calls (stateless request/response) have
                           // something to call .send()/.getMembers() etc. on
let p2pPumpTimer = null;

function initNetworking() {
    // Auto-accept every P2P session: this is aimed at "play with a friend"
    // games, not an adversarial ladder — no handshake/allowlist needed, and
    // without this Steam silently drops packets from a session it hasn't
    // been told to accept.
    steam.callback.register(steam.callback.SteamCallback.P2PSessionRequest, ({ remote }) => {
        steam.networking.acceptP2PSession(remote);
    });
    steam.callback.register(steam.callback.SteamCallback.LobbyChatUpdate, (data) => {
        safeSend('steam:lobbyChatUpdate', {
            lobby: String(data.lobby),
            userChanged: String(data.user_changed),
            memberStateChange: data.member_state_change,
        });
    });
    // Fires when the user accepts a Steam overlay/friends-list "Join Game"
    // invite — may happen before the game has created or joined any lobby
    // itself, so this is registered unconditionally at init time, not
    // scoped to an active lobby.
    steam.callback.register(steam.callback.SteamCallback.GameLobbyJoinRequested, (data) => {
        safeSend('steam:lobbyJoinRequested', { lobbySteamId: String(data.lobby_steam_id) });
    });

    // isP2PPacketAvailable/readP2PPacket are pull-based (unlike the push
    // callbacks above) — drain them on a timer. ~60Hz matches the cost of a
    // typical game loop tick and keeps relay latency low without busy-looping.
    p2pPumpTimer = setInterval(() => {
        let size;
        while ((size = steam.networking.isP2PPacketAvailable()) > 0) {
            const pkt = steam.networking.readP2PPacket(size);
            let data;
            try {
                data = JSON.parse(pkt.data.toString('utf8'));
            } catch {
                continue; // malformed/foreign packet — drop rather than crash the pump
            }
            safeSend('steam:p2pData', { steamId64: String(pkt.steamId.steamId64), data });
        }
    }, 16);
}

// ── Storage ───────────────────────────────────────────────────────────────────

function getSavePath() {
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'save.json');
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWin = null;

// module-scope (not just createWindow-local) — networking callbacks below
// fire from Steam's own event pump, not from a window event, and still need
// a safe way to reach the renderer.
function safeSend(channel, data) {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data);
}

function createWindow() {
    // Packaged mac/win builds get their icon from the bundle/exe; this path
    // only exists in dev and in packaged Linux builds (extraResources).
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : cfg.iconPath;
    mainWin = new BrowserWindow({
        width: 1280,
        height: 720,
        center: true,
        icon: iconPath && fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWin.removeMenu();

    mainWin.loadFile(indexHtml);

    mainWin.on('move',   () => safeSend('win:moved'));
    mainWin.on('resize', () => safeSend('win:resized'));
    mainWin.on('closed', () => { mainWin = null; });
}

// Optional per-game main-process hook (steam-electron-build.extend.cjs in the game repo)
function loadExtend() {
    const extendPath = app.isPackaged
        ? path.join(app.getAppPath(), 'electron', 'extend.cjs')
        : cfg.extendPath;
    if (!extendPath || !fs.existsSync(extendPath)) return;
    try {
        require(extendPath)({
            app,
            ipcMain,
            getSteam: () => steam,
            getWindow: () => mainWin,
        });
    } catch (e) {
        console.warn('[steam-electron-build] extend hook failed:', e.message);
    }
}

app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged
        && cfg.iconPath && fs.existsSync(cfg.iconPath)) {
        app.dock.setIcon(cfg.iconPath);
    }
    initSteam();
    loadExtend();
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

// ── IPC: Lobbies ──────────────────────────────────────────────────────────────
// `type`: 'private' (invite-only, not returned by getLobbies — for a direct
// friend invite) or 'public' (discoverable — for anonymous quick-match).
// bigint (lobby/steam ids) never crosses IPC directly — always String() out,
// BigInt(...) back in at the steamworks.js call site, since contextBridge's
// structured-clone support for bigint isn't a documented guarantee.

const LOBBY_TYPES = { private: 0 /* Private */, public: 2 /* Public */ };

function describeLobby(lobby) {
    const limit = lobby.getMemberLimit();
    return {
        id: String(lobby.id),
        memberCount: Number(lobby.getMemberCount()),
        memberLimit: limit === null ? null : Number(limit),
        owner: String(lobby.getOwner().steamId64),
        data: lobby.getFullData(),
    };
}

ipcMain.handle('steam:lobbyCreate', async (_e, type, maxMembers) => {
    if (!steam) return null;
    currentLobby = await steam.matchmaking.createLobby(LOBBY_TYPES[type] ?? LOBBY_TYPES.private, maxMembers);
    return describeLobby(currentLobby);
});

ipcMain.handle('steam:lobbyJoin', async (_e, lobbyIdStr) => {
    if (!steam) return null;
    currentLobby = await steam.matchmaking.joinLobby(BigInt(lobbyIdStr));
    return describeLobby(currentLobby);
});

ipcMain.handle('steam:lobbyLeave', () => {
    currentLobby?.leave();
    currentLobby = null;
});

ipcMain.handle('steam:lobbyGetMembers', () =>
    currentLobby ? currentLobby.getMembers().map((m) => String(m.steamId64)) : []);

ipcMain.handle('steam:lobbyGetOwner', () =>
    currentLobby ? String(currentLobby.getOwner().steamId64) : null);

ipcMain.handle('steam:lobbySetData', (_e, key, value) =>
    currentLobby?.setData(key, value) ?? false);

ipcMain.handle('steam:lobbyGetData', (_e, key) =>
    currentLobby?.getData(key) ?? null);

ipcMain.handle('steam:lobbyGetFullData', () =>
    currentLobby?.getFullData() ?? {});

ipcMain.handle('steam:lobbyMergeFullData', (_e, data) =>
    currentLobby?.mergeFullData(data) ?? false);

ipcMain.handle('steam:lobbySetJoinable', (_e, flag) =>
    currentLobby?.setJoinable(flag) ?? false);

ipcMain.handle('steam:lobbyOpenInviteDialog', () => {
    currentLobby?.openInviteDialog();
});

ipcMain.handle('steam:lobbyGetLobbies', async () => {
    if (!steam) return [];
    const lobbies = await steam.matchmaking.getLobbies();
    return lobbies.map(describeLobby);
});

// ── IPC: P2P networking ───────────────────────────────────────────────────────
// Payloads are arbitrary JSON-serializable game messages — this layer only
// moves bytes, it has no opinion on what's inside (mirrors how NetSession's
// PeerJS DataConnection is used on the web build).
//
// SendType is a TS `const enum` in steamworks.js — erased at compile time,
// never exported as a runtime object — so the raw value is used directly.
const SEND_TYPE_RELIABLE = 2;

ipcMain.handle('steam:netSend', (_e, steamId64Str, payload) => {
    if (!steam) return false;
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    return steam.networking.sendP2PPacket(BigInt(steamId64Str), SEND_TYPE_RELIABLE, buf);
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
