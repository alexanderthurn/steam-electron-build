const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { createLan } = require('./lan.cjs');

// ── Config ────────────────────────────────────────────────────────────────────
// dev:      full config passed by the CLI via env (absolute paths)
// packaged: read from the staged app's package.json "steamElectronBuild" block

const cfg = process.env.STEAM_ELECTRON_BUILD_CONFIG
    ? JSON.parse(process.env.STEAM_ELECTRON_BUILD_CONFIG)
    : require(path.join(app.getAppPath(), 'package.json')).steamElectronBuild;

// Opt-in LAN PeerServer + UDP discovery. Default off so games that never
// call it never open ports or load `peer`.
const lanEnabled = cfg.lan === true;

// Opt-in frame-mirrored Steam overlay (steamworks-ffi-node addElectronSteamOverlay).
// Default stays off — use STEAM_ELECTRON_NATIVE_OVERLAY=1 or `dev --overlay`.
// This is a probe path (see example/): Chromium cannot host Steam's injector, so
// ffi-node opens a second borderless Metal/GL mirror window. Enable it on every
// OS so you can see whether the current stack works on this machine.
const nativeOverlayEnabled = process.env.STEAM_ELECTRON_NATIVE_OVERLAY === '1'
    || cfg.nativeOverlay === true;
if (nativeOverlayEnabled) process.env.STEAM_ELECTRON_NATIVE_OVERLAY = '1';
else delete process.env.STEAM_ELECTRON_NATIVE_OVERLAY;

/** Probe status for the example HUD — requested vs actually attached. */
const nativeOverlayStatus = {
    requested: nativeOverlayEnabled,
    attached: false,
    available: null,
    platform: process.platform,
    error: null,
};

const indexHtml = process.env.STEAM_ELECTRON_BUILD_CONFIG
    ? path.join(cfg.distDir, 'index.html')
    : path.join(app.getAppPath(), 'dist', 'index.html');

app.setName(cfg.productName);
// Deterministic save location (same in dev and packaged builds)
app.setPath('userData', path.join(app.getPath('appData'), cfg.appId));

// ── Resolve Steamworks SDK redistributables ───────────────────────────────────
// steamworks-ffi-node cannot legally ship libsteam_api; we stage Valve's
// redistributable_bin under steamworks_sdk/ (package root in dev, next to
// resources in packaged builds).

function resolveSteamSdkPath() {
    const candidates = [];
    if (cfg.steamSdkPath) candidates.push(cfg.steamSdkPath);
    if (app.isPackaged) {
        candidates.push(path.join(process.resourcesPath, 'steamworks_sdk'));
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'steamworks_sdk'));
    } else {
        if (cfg.packageRoot) candidates.push(path.join(cfg.packageRoot, 'steamworks_sdk'));
        candidates.push(path.join(__dirname, '..', 'steamworks_sdk'));
        candidates.push(path.join(process.cwd(), 'steamworks_sdk'));
    }
    for (const p of candidates) {
        if (p && fs.existsSync(path.join(p, 'redistributable_bin'))) return p;
    }
    return null;
}

// ── Linux: fix library search path before any native modules load ─────────────
if (process.platform === 'linux') {
    const dirs = [];
    const sdk = resolveSteamSdkPath();
    if (sdk) dirs.push(path.join(sdk, 'redistributable_bin', 'linux64'));
    if (app.isPackaged) {
        dirs.push(path.join(process.resourcesPath, 'app.asar.unpacked',
            'node_modules', 'steamworks-ffi-node', 'prebuilds', 'linux-x64'));
    }
    dirs.push(path.dirname(process.execPath));
    if (process.env.LD_LIBRARY_PATH) dirs.push(process.env.LD_LIBRARY_PATH);
    process.env.LD_LIBRARY_PATH = dirs.join(':');

    // Required for Steam Linux runtime: sandbox and zygote process model fail there.
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
    app.commandLine.appendSwitch('no-zygote');
}

// ── Steam ─────────────────────────────────────────────────────────────────────

let SteamworksSDK = null; // module
let steam = null;         // SteamworksSDK instance after init

function initSteam() {
    try {
        SteamworksSDK = require(cfg.steamFfiPath ?? 'steamworks-ffi-node');
    } catch (e) {
        console.warn('[Steam] Load failed:', e.message);
        return;
    }

    const sdkPath = resolveSteamSdkPath();
    if (!sdkPath) {
        console.warn('[Steam] steamworks_sdk/redistributable_bin not found — Steam disabled');
        return;
    }

    try {
        const SteamClass = SteamworksSDK.SteamworksSDK || SteamworksSDK.default || SteamworksSDK;
        steam = SteamClass.getInstance();

        if (typeof steam.setSdkPath === 'function') {
            steam.setSdkPath(sdkPath);
        }

        // Steam sets SteamAppId to whichever app it launched us as, which is a
        // different id for a playtest or demo than the one baked into the build.
        // Trusting the environment lets one binary serve all of them; the config
        // value is the fallback for running outside the Steam client.
        const launchedAs = Number(process.env.SteamAppId || process.env.SteamGameId);
        const ok = steam.init({ appId: launchedAs || Number(cfg.steamAppId) || 480 });
        if (!ok) {
            console.warn('[Steam] Init returned false');
            steam = null;
            return;
        }
        const status = steam.getStatus?.() ?? {};
        console.log('[Steam] Initialized:', steam.friends?.getPersonaName?.() ?? status.steamId ?? 'ok');
        initNetworking();
        startSteamPumps();
        emitConnectLobbyFromArgv();
    } catch (e) {
        console.warn('[Steam] Init failed:', e.message);
        steam = null;
    }
}

// ── Networking (lobbies + Networking Sockets) ─────────────────────────────────

let currentLobbyId = null; // string steam id
let listenSocket = null;
let pollGroup = null;
/** @type {Map<string, number>} steamId64 -> connection handle */
const connBySteamId = new Map();
/** @type {Map<number, string>} connection handle -> steamId64 */
const steamIdByConn = new Map();
/** @type {Map<string, object[]>} queued payloads until Connected */
const pendingBySteamId = new Map();
/** @type {Set<string>} last known lobby members for join/leave diffs */
let lastLobbyMembers = new Set();
let steamPumpTimer = null;

function steamEnums() {
    try {
        return require(cfg.steamFfiPath ?? 'steamworks-ffi-node');
    } catch {
        return {};
    }
}

const LOBBY_TYPE = { private: 0, public: 2 }; // ELobbyType Private=0 Public=2
const CONN_CONNECTED = 3;
const CONN_CLOSED_BY_PEER = 5;
const CONN_PROBLEM = 6;
const ERESULT_OK = 1;
/** Steamworks: invalid HSteamNetConnection / listen socket / poll group handle */
const HCONN_INVALID = 0;

function initNetworking() {
    if (!steam?.networkingSockets) return;

    try {
        pollGroup = steam.networkingSockets.createPollGroup();
    } catch (e) {
        console.warn('[Steam] createPollGroup failed:', e.message);
    }

    steam.networkingSockets.onConnectionRequest((request) => {
        try {
            const result = steam.networkingSockets.acceptConnection(request.connection);
            if (result !== ERESULT_OK) {
                console.warn('[Steam] acceptConnection failed:', result);
                return;
            }
            rememberConnection(request.connection, normalizeSteamId(request.identityRemote));
        } catch (e) {
            console.warn('[Steam] Connection request handler failed:', e.message);
        }
    });

    steam.networkingSockets.onConnectionStateChange((change) => {
        const steamId = normalizeSteamId(change.identityRemote)
            || steamIdByConn.get(change.connection)
            || null;
        if (change.newState === CONN_CONNECTED) {
            if (steamId) {
                rememberConnection(change.connection, steamId);
                flushPending(steamId);
            }
        } else if (
            change.newState === CONN_CLOSED_BY_PEER
            || change.newState === CONN_PROBLEM
        ) {
            forgetConnection(change.connection);
        }
    });
}

function normalizeSteamId(identity) {
    if (identity == null) return null;
    const s = String(identity);
    const m = s.match(/(\d{17,})/);
    return m ? m[1] : (s && s !== '0' ? s : null);
}

function rememberConnection(connection, steamId64) {
    if (!connection || connection === HCONN_INVALID || !steamId64) return;
    connBySteamId.set(steamId64, connection);
    steamIdByConn.set(connection, steamId64);
    if (pollGroup != null) {
        try { steam.networkingSockets.setConnectionPollGroup(connection, pollGroup); } catch { /* ignore */ }
    }
}

function forgetConnection(connection) {
    const steamId = steamIdByConn.get(connection);
    steamIdByConn.delete(connection);
    if (steamId && connBySteamId.get(steamId) === connection) connBySteamId.delete(steamId);
}

function ensureListenSocket() {
    if (!steam?.networkingSockets || listenSocket != null) return;
    try {
        const sock = steam.networkingSockets.createListenSocketP2P(0);
        if (!sock || sock === HCONN_INVALID) {
            console.warn('[Steam] createListenSocketP2P failed');
            return;
        }
        listenSocket = sock;
    } catch (e) {
        console.warn('[Steam] listen socket error:', e.message);
    }
}

function ensureConnection(steamId64) {
    if (!steam?.networkingSockets || !steamId64) return null;
    const existing = connBySteamId.get(steamId64);
    if (existing != null && existing !== HCONN_INVALID
        && steam.networkingSockets.isConnectionActive?.(existing) !== false) {
        return existing;
    }
    try {
        const conn = steam.networkingSockets.connectP2P(steamId64, 0);
        if (!conn || conn === HCONN_INVALID) return null;
        rememberConnection(conn, steamId64);
        return conn;
    } catch (e) {
        console.warn('[Steam] connectP2P failed:', e.message);
        return null;
    }
}

function flushPending(steamId64) {
    const q = pendingBySteamId.get(steamId64);
    if (!q?.length) return;
    pendingBySteamId.delete(steamId64);
    for (const payload of q) sendOnConnection(steamId64, payload);
}

function sendOnConnection(steamId64, payload) {
    const conn = connBySteamId.get(steamId64);
    if (conn == null) return false;
    const info = steam.networkingSockets.getConnectionInfo?.(conn);
    const connected = !info || info.state === CONN_CONNECTED;
    if (!connected) {
        const q = pendingBySteamId.get(steamId64) ?? [];
        q.push(payload);
        pendingBySteamId.set(steamId64, q);
        return true; // accepted into queue
    }
    try {
        const result = steam.networkingSockets.sendReliable(conn, Buffer.from(JSON.stringify(payload), 'utf8'));
        return !!(result && result.success);
    } catch (e) {
        console.warn('[Steam] sendReliable failed:', e.message);
        return false;
    }
}

function closeNetworking() {
    pendingBySteamId.clear();
    connBySteamId.clear();
    steamIdByConn.clear();
    if (steam?.networkingSockets) {
        try { steam.networkingSockets.closeAll(); } catch { /* ignore */ }
    }
    listenSocket = null;
    // poll group is destroyed by closeAll; recreate on next lobby
    pollGroup = null;
    try {
        if (steam?.networkingSockets) pollGroup = steam.networkingSockets.createPollGroup();
    } catch { /* ignore */ }
}

function describeLobby(lobbyId) {
    const mm = steam.matchmaking;
    const limit = mm.getLobbyMemberLimit(lobbyId);
    return {
        id: String(lobbyId),
        memberCount: Number(mm.getNumLobbyMembers(lobbyId)),
        memberLimit: limit === 0 || limit == null ? null : Number(limit),
        owner: String(mm.getLobbyOwner(lobbyId)),
        data: mm.getAllLobbyData(lobbyId) ?? {},
    };
}

function afterLobbyReady(lobbyId) {
    currentLobbyId = String(lobbyId);
    lastLobbyMembers = new Set(steam.matchmaking.getLobbyMembers(lobbyId).map(String));
    ensureListenSocket();
    const owner = String(steam.matchmaking.getLobbyOwner(lobbyId));
    const self = String(steam.getStatus?.().steamId ?? '');
    if (owner && self && owner !== self) ensureConnection(owner);
}

function emitConnectLobbyFromArgv() {
    // Steam launches with `+connect_lobby <id>` when the user accepts a
    // Join Game invite that starts the app. ffi-node does not yet expose
    // GameLobbyJoinRequested for already-running instances.
    const args = process.argv;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '+connect_lobby' && args[i + 1]) {
            const lobbySteamId = String(args[i + 1]);
            // Defer until the window exists so the renderer can subscribe.
            setTimeout(() => safeSend('steam:lobbyJoinRequested', { lobbySteamId }), 500);
            return;
        }
        const m = String(args[i]).match(/^\+connect_lobby[=:]?(\d+)/);
        if (m) {
            setTimeout(() => safeSend('steam:lobbyJoinRequested', { lobbySteamId: m[1] }), 500);
            return;
        }
    }
}

function startSteamPumps() {
    if (steamPumpTimer) return;
    steamPumpTimer = setInterval(() => {
        if (!steam) return;
        try { steam.runCallbacks(); } catch { /* ignore */ }
        try { steam.networkingSockets?.runCallbacks?.(); } catch { /* ignore */ }

        // Lobby member join/leave (ffi-node has no LobbyChatUpdate push callback)
        if (currentLobbyId) {
            try {
                const members = steam.matchmaking.getLobbyMembers(currentLobbyId).map(String);
                const now = new Set(members);
                for (const id of now) {
                    if (!lastLobbyMembers.has(id)) {
                        safeSend('steam:lobbyChatUpdate', {
                            lobby: currentLobbyId,
                            userChanged: id,
                            memberStateChange: 1, // Entered
                        });
                        // Non-owners: ensure a socket to the lobby owner.
                        const owner = String(steam.matchmaking.getLobbyOwner(currentLobbyId));
                        const self = String(steam.getStatus?.().steamId ?? '');
                        if (owner && self && owner !== self) ensureConnection(owner);
                    }
                }
                for (const id of lastLobbyMembers) {
                    if (!now.has(id)) {
                        safeSend('steam:lobbyChatUpdate', {
                            lobby: currentLobbyId,
                            userChanged: id,
                            memberStateChange: 2, // Left
                        });
                    }
                }
                lastLobbyMembers = now;
            } catch { /* ignore */ }
        }

        // Drain Networking Sockets messages
        try {
            const ns = steam.networkingSockets;
            if (!ns) return;
            const messages = pollGroup != null
                ? ns.receiveMessagesOnPollGroup(pollGroup, 32)
                : ns.getActiveConnections().flatMap((c) => ns.receiveMessages(c, 16));
            for (const msg of messages) {
                const steamId64 = steamIdByConn.get(msg.connection)
                    || normalizeSteamId(msg.identityPeer)
                    || null;
                if (!steamId64) continue;
                let data;
                try {
                    data = JSON.parse(Buffer.from(msg.data).toString('utf8'));
                } catch {
                    continue;
                }
                safeSend('steam:p2pData', { steamId64, data });
            }
        } catch { /* ignore */ }
    }, 16);
}

// ── Storage ───────────────────────────────────────────────────────────────────

// Callers may name their own file (settings, replays, …) so a Steam Auto-Cloud
// rule can match some and skip others. basename() keeps a crafted name from
// escaping the app-data dir.
function getSavePath(file) {
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    const name = typeof file === 'string' && file.trim() ? path.basename(file.trim()) : 'save.json';
    return path.join(dataDir, name);
}

// ── Window state ──────────────────────────────────────────────────────────────
// Remembered across launches in the app-data dir. Deliberately NOT a .sav:
// geometry is machine-specific, and a desktop's 2560x1440 bounds arriving on a
// 1280x800 Steam Deck via Steam Cloud would put the window off the screen.

const WINDOW_STATE_FILE = 'window-state.json';
const DEFAULT_BOUNDS = { width: 1280, height: 720 };

function readWindowState() {
    try {
        const raw = fs.readFileSync(path.join(app.getPath('userData'), WINDOW_STATE_FILE), 'utf8');
        const s = JSON.parse(raw);
        return s && typeof s === 'object' ? s : {};
    } catch {
        return {};   // absent or corrupt: first launch behaviour
    }
}

function writeWindowState(state) {
    try {
        fs.writeFileSync(
            path.join(app.getPath('userData'), WINDOW_STATE_FILE),
            JSON.stringify(state),
            'utf8',
        );
    } catch { /* read-only home, quota — never worth failing a quit over */ }
}

/**
 * Saved bounds are only usable if they still fit a display that exists now.
 * Guards against unplugged monitors, resolution changes and moving an install
 * (or a synced file) onto a smaller screen such as the Deck.
 */
function usableBounds(saved) {
    if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null;
    if (saved.width < 640 || saved.height < 480) return null;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') {
        return { width: saved.width, height: saved.height };
    }
    const area = screen.getDisplayMatching(saved).workArea;
    const visible = saved.x < area.x + area.width && saved.x + saved.width > area.x
        && saved.y < area.y + area.height && saved.y + saved.height > area.y;
    if (!visible) return null;
    return {
        x: saved.x,
        y: saved.y,
        width: Math.min(saved.width, area.width),
        height: Math.min(saved.height, area.height),
    };
}

// ── High-DPI UI scaling ───────────────────────────────────────────────────────
// On a 4K display with OS scaling at 100% (common on Windows), HTML UI renders
// at tiny physical sizes while the 3D canvas is unaffected. Scale the page to a
// 1280x800 reference, never below 1 — the same policy DICEPTION uses.
//
// Chromium's zoom applies beneath the coordinate system, so layout, pointer
// coordinates, getBoundingClientRect and devicePixelRatio stay consistent with
// each other. A CSS transform on <body> achieves the same look but desyncs
// element rects from canvas pixels, which silently breaks pointer-to-world math
// in games that subtract rect origins without dividing by the scale.
//
// Trade-off: the canvas now sizes to the zoomed (smaller) CSS viewport, so the
// 3D backing store is cssSize x devicePixelRatio. Games capping DPR below the
// zoom factor render below native resolution — sharper UI, slightly softer 3D.

const UI_SCALE_REF = { width: 1280, height: 800 };

/** Player-chosen multiplier on top of the automatic factor (1 = untouched). */
let uiScaleUser = 1;

function applyUiZoom() {
    if (cfg.uiScale === false) return;   // opt out: game handles its own scaling
    if (!mainWin || mainWin.isDestroyed()) return;
    const { width, height } = mainWin.getContentBounds();
    if (!width || !height) return;
    const auto = Math.max(1, Math.min(width / UI_SCALE_REF.width, height / UI_SCALE_REF.height));
    const scale = auto * uiScaleUser;
    const rounded = Math.round(scale * 100) / 100;
    try {
        if (mainWin.webContents.getZoomFactor() !== rounded) {
            mainWin.webContents.setZoomFactor(rounded);
            // Zoom changes the CSS viewport without a window 'resize' on some
            // platforms (esp. entering macOS fullscreen) — tell the game to
            // remeasure so canvases/filters don't keep a stale size.
            safeSend('win:resized');
        }
    } catch { /* window torn down mid-resize */ }
}

// ── Window ────────────────────────────────────────────────────────────────────

let mainWin = null;

function safeSend(channel, data) {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data);
}

function createWindow() {
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : cfg.iconPath;
    const saved = readWindowState();
    const bounds = usableBounds(saved.bounds) ?? DEFAULT_BOUNDS;
    // First launch follows the game's config (default fullscreen — what players
    // expect from Steam, and the only sensible mode on the Deck); after that the
    // player's own last choice wins.
    // Native overlay opens a second mirrored window — fullscreen on macOS stacks
    // both views; force windowed when that path is opted in.
    const startFullscreen = nativeOverlayEnabled
        ? false
        : (typeof saved.fullscreen === 'boolean'
            ? saved.fullscreen
            : cfg.fullscreen !== false);

    mainWin = new BrowserWindow({
        ...bounds,
        center: bounds.x === undefined,
        // Only ever pass this when true: Electron documents that explicitly
        // passing false hides or disables the fullscreen button on macOS, which
        // also makes setFullScreen() a silent no-op for the window's lifetime.
        ...(startFullscreen ? { fullscreen: true } : {}),
        fullscreenable: true,
        frame: true,
        resizable: true,
        minimizable: true,
        maximizable: true,
        closable: true,
        title: cfg.productName || 'Game',
        icon: iconPath && fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    // Keep the native title bar / traffic lights; only drop the app menu bar.
    mainWin.removeMenu();
    mainWin.setMenuBarVisibility(false);

    mainWin.loadFile(indexHtml);
    // Zoom must be re-applied per load: it is a property of the loaded frame.
    mainWin.webContents.on('did-finish-load', () => {
        applyUiZoom();
        maybeAttachNativeOverlay();
    });

    // Remember geometry only while windowed — capturing bounds in fullscreen or
    // maximized would save the screen size and lose the restore size.
    let saveTimer = null;
    // Tracks the live windowed rect. Must not fall back to the file's value:
    // going fullscreen after moving the window would then rewrite the position
    // with the one from launch, and the next launch would open fullscreen on
    // whichever monitor the window started on rather than the one it ended on.
    let windowedBounds = usableBounds(saved.bounds) ?? null;
    const rememberWindowState = () => {
        if (!mainWin || mainWin.isDestroyed()) return;
        const state = { fullscreen: mainWin.isFullScreen() };
        if (!state.fullscreen && !mainWin.isMaximized() && !mainWin.isMinimized()) {
            windowedBounds = mainWin.getNormalBounds();
        }
        if (windowedBounds) state.bounds = windowedBounds;
        writeWindowState(state);
    };
    const scheduleRemember = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(rememberWindowState, 400);   // drags fire continuously
    };

    mainWin.on('move',   () => { safeSend('win:moved'); scheduleRemember(); });
    mainWin.on('resize', () => { safeSend('win:resized'); scheduleRemember(); applyUiZoom(); });
    mainWin.on('enter-full-screen', () => {
        rememberWindowState();
        applyUiZoom();
        // macOS fullscreen often skips a meaningful DOM resize for the page.
        safeSend('win:resized');
    });
    mainWin.on('leave-full-screen', () => {
        rememberWindowState();
        applyUiZoom();
        safeSend('win:resized');
    });
    mainWin.on('close', () => {
        if (saveTimer) clearTimeout(saveTimer);
        rememberWindowState();
    });
    mainWin.on('closed', () => { mainWin = null; });
}

/** Attach steamworks-ffi-node's mirrored native overlay when opted in. */
let nativeOverlayAttached = false;
function maybeAttachNativeOverlay() {
    if (nativeOverlayAttached || !nativeOverlayEnabled || !mainWin || mainWin.isDestroyed()) return;
    if (!steam) {
        nativeOverlayStatus.error = 'Steam not initialized';
        console.warn('[Steam] Native overlay requested but Steam is not initialized');
        safeSend('win:nativeOverlayStatus', { ...nativeOverlayStatus });
        return;
    }
    if (typeof steam.isOverlayAvailable !== 'function' || !steam.isOverlayAvailable()) {
        nativeOverlayStatus.available = false;
        nativeOverlayStatus.error = 'isOverlayAvailable() is false';
        console.warn('[Steam] Native overlay requested but isOverlayAvailable() is false');
        safeSend('win:nativeOverlayStatus', { ...nativeOverlayStatus });
        return;
    }
    nativeOverlayStatus.available = true;

    // Mirror + fullscreen stacks two desktops on macOS — keep windowed for the probe.
    if (mainWin.isFullScreen()) {
        mainWin.setFullScreen(false);
    }

    // ffi-node ≥0.11 uses beginFrameSubscription; disable throttling so Mac
    // occlusion (mirror covering Electron) does not freeze frame delivery.
    try { mainWin.webContents.setBackgroundThrottling(false); } catch { /* older Electron */ }

    const attach = () => {
        if (nativeOverlayAttached || !mainWin || mainWin.isDestroyed() || !steam) return;
        const { width, height } = mainWin.getContentBounds();
        if (width < 2 || height < 2) {
            setTimeout(attach, 200);
            return;
        }
        try {
            const ok = steam.addElectronSteamOverlay(mainWin, {
                title: cfg.productName || 'Game',
                fps: 60,
                vsync: true,
            });
            nativeOverlayStatus.attached = !!ok;
            nativeOverlayStatus.error = ok ? null : 'addElectronSteamOverlay returned false';
            if (ok) nativeOverlayAttached = true;
            console.log(ok
                ? `[Steam] Native overlay ATTACHED on ${process.platform} — press Shift+Tab to test injection`
                : '[Steam] Native overlay attach returned false');
            if (ok) {
                console.log('[Steam] Expect a second borderless Metal/GL mirror (required by ffi-node).');
                console.log('[Steam] If Shift+Tab does nothing: add this binary as a non-Steam game, restart Steam, launch from Steam.');
            }
            safeSend('win:nativeOverlayStatus', { ...nativeOverlayStatus });
        } catch (e) {
            nativeOverlayStatus.attached = false;
            nativeOverlayStatus.error = e.message;
            console.warn('[Steam] Native overlay failed:', e.message);
            safeSend('win:nativeOverlayStatus', { ...nativeOverlayStatus });
        }
    };

    // Wait for a real paint so the first subscribed frame is non-empty (avoids
    // "[Metal Overlay] WARNING: No texture or pipeline state! texture=0x0").
    mainWin.webContents.once('paint', () => setTimeout(attach, 100));
    // Fallback if 'paint' never fires (some Electron builds).
    setTimeout(attach, 1200);
}

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

const lan = createLan({
    enabled: lanEnabled,
    appId: cfg.appId ?? cfg.productName ?? 'game',
    discoveryPort: cfg.lanDiscoveryPort,
});

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
    void lan.stopHost();
    if (steamPumpTimer) clearInterval(steamPumpTimer);
    closeNetworking();
    try { steam?.shutdown?.(); } catch { /* ignore */ }
    app.quit();
    if (process.platform === 'linux') setTimeout(() => process.exit(0), 300);
});

// ── IPC: Steam ────────────────────────────────────────────────────────────────

ipcMain.handle('steam:getUserName', () =>
    steam?.friends?.getPersonaName?.() ?? '');

ipcMain.handle('steam:getSteamId', () =>
    String(steam?.getStatus?.().steamId ?? '0'));

ipcMain.handle('steam:getAvatarDataUrl', async () => {
    if (!steam) return null;
    try {
        const steamId64 = String(steam.getStatus?.().steamId ?? '');
        if (!steamId64 || steamId64 === '0') return null;

        // Prefer native Steam image cache (no network). Avatar may need a
        // few frames to load into the cache after the first request.
        let handle = 0;
        for (let i = 0; i < 20; i++) {
            handle = steam.friends.getLargeFriendAvatar(steamId64)
                || steam.friends.getMediumFriendAvatar(steamId64)
                || 0;
            if (handle > 0) break;
            steam.runCallbacks();
            await new Promise((r) => setTimeout(r, 50));
        }
        if (handle > 0) {
            const rgba = steam.utils.getImageRGBA(handle);
            if (rgba?.data?.length) {
                // Encode raw RGBA as an uncompressed BMP-ish PNG via a tiny data URL
                // using Electron-available canvas is unavailable in main — fall through
                // to community CDN if we cannot PNG-encode. Use a minimal PNG encoder:
                return rgbaToPngDataUrl(rgba.width, rgba.height, rgba.data) ?? null;
            }
        }

        // Fallback: public community avatar (same as former steamworks.js path).
        const xmlRes = await fetch(`https://steamcommunity.com/profiles/${steamId64}/?xml=1`);
        if (!xmlRes.ok) return null;
        const xml = await xmlRes.text();
        const match =
            xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/) ||
            xml.match(/<avatarFull>([^<]+)<\/avatarFull>/) ||
            xml.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/) ||
            xml.match(/<avatarMedium>([^<]+)<\/avatarMedium>/);
        const url = match?.[1]?.trim();
        if (!url || !/^https?:\/\//i.test(url)) return null;
        const imgRes = await fetch(url);
        if (!imgRes.ok) return null;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const mime = imgRes.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
        if (!mime.startsWith('image/')) return null;
        return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e) {
        console.warn('[Steam] Avatar fetch failed:', e instanceof Error ? e.message : e);
        return null;
    }
});

/** Minimal uncompressed PNG encoder for Steam RGBA avatars (no deps). */
function rgbaToPngDataUrl(width, height, rgba) {
    try {
        const { deflateSync } = require('zlib');
        const raw = Buffer.alloc((width * 4 + 1) * height);
        for (let y = 0; y < height; y++) {
            raw[y * (width * 4 + 1)] = 0; // filter none
            rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
        }
        const compressed = deflateSync(raw);
        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(width, 0);
        ihdr.writeUInt32BE(height, 4);
        ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
        const crcTable = (() => {
            const t = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                t[n] = c;
            }
            return t;
        })();
        const crc = (buf) => {
            let c = 0xffffffff;
            for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
            return (c ^ 0xffffffff) >>> 0;
        };
        const chunk = (type, data) => {
            const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
            const typeB = Buffer.from(type);
            const crcB = Buffer.alloc(4);
            crcB.writeUInt32BE(crc(Buffer.concat([typeB, data])), 0);
            return Buffer.concat([len, typeB, data, crcB]);
        };
        const png = Buffer.concat([
            signature,
            chunk('IHDR', ihdr),
            chunk('IDAT', compressed),
            chunk('IEND', Buffer.alloc(0)),
        ]);
        return `data:image/png;base64,${png.toString('base64')}`;
    } catch {
        return null;
    }
}

ipcMain.handle('steam:getAppId', () =>
    steam?.utils?.getAppID?.() ?? steam?.getStatus?.().appId ?? 0);

ipcMain.handle('steam:getCurrentBetaName', () => {
    const name = steam?.apps?.getCurrentBetaName?.();
    return name && String(name).trim() ? String(name) : null;
});

ipcMain.handle('steam:isDev', () =>
    !app.isPackaged);

ipcMain.handle('steam:quit', () =>
    app.quit());

ipcMain.handle('steam:activateOverlay', (_e, dialog) => {
    if (!steam) return;
    try {
        steam.overlay.activateGameOverlay(dialog || 'Friends');
    } catch (e) {
        console.warn('[Steam] activateOverlay failed:', e.message);
    }
});

ipcMain.handle('steam:openStore', () => {
    if (!steam) return;
    try {
        const appId = steam.utils.getAppID();
        steam.overlay.activateGameOverlayToStore(appId, 0);
    } catch (e) {
        console.warn('[Steam] openStore failed:', e.message);
    }
});

ipcMain.handle('steam:unlockAchievement', async (_e, id) => {
    if (!steam) return;
    await steam.achievements.unlockAchievement(id);
});

ipcMain.handle('steam:getUnlockedAchievements', async (_e, ids) => {
    if (!steam) return [];
    const out = [];
    for (const id of ids) {
        if (await steam.achievements.isAchievementUnlocked(id)) out.push(id);
    }
    return out;
});

ipcMain.handle('steam:getStatI32', async (_e, name) => {
    if (!steam) return 0;
    const stat = await steam.stats.getStatInt(name);
    return stat?.value ?? 0;
});

ipcMain.handle('steam:setStat', async (_e, name, value) => {
    if (!steam) return;
    await steam.stats.setStatInt(name, value);
});

ipcMain.handle('steam:clearAchievement', async (_e, id) => {
    if (!steam) return;
    await steam.achievements.clearAchievement(id);
});

ipcMain.handle('steam:resetAllStats', async (_e, achievementsToo) => {
    if (!steam) return false;
    return !!(await steam.achievements.resetAllStats(!!achievementsToo));
});

// ── IPC: Lobbies ──────────────────────────────────────────────────────────────

ipcMain.handle('steam:lobbyCreate', async (_e, type, maxMembers) => {
    if (!steam) return null;
    const result = await steam.matchmaking.createLobby(
        LOBBY_TYPE[type] ?? LOBBY_TYPE.private,
        maxMembers,
    );
    if (!result?.success || !result.lobbyId) {
        console.warn('[Steam] lobbyCreate failed:', result?.error);
        return null;
    }
    afterLobbyReady(result.lobbyId);
    return describeLobby(result.lobbyId);
});

ipcMain.handle('steam:lobbyJoin', async (_e, lobbyIdStr) => {
    if (!steam) return null;
    const result = await steam.matchmaking.joinLobby(String(lobbyIdStr));
    if (!result?.success || !result.lobbyId) {
        console.warn('[Steam] lobbyJoin failed:', result?.error ?? result?.response);
        return null;
    }
    afterLobbyReady(result.lobbyId);
    return describeLobby(result.lobbyId);
});

ipcMain.handle('steam:lobbyLeave', () => {
    if (steam && currentLobbyId) {
        try { steam.matchmaking.leaveLobby(currentLobbyId); } catch { /* ignore */ }
    }
    currentLobbyId = null;
    lastLobbyMembers = new Set();
    closeNetworking();
});

ipcMain.handle('steam:lobbyGetMembers', () =>
    currentLobbyId ? steam.matchmaking.getLobbyMembers(currentLobbyId).map(String) : []);

ipcMain.handle('steam:lobbyGetOwner', () =>
    currentLobbyId ? String(steam.matchmaking.getLobbyOwner(currentLobbyId)) : null);

ipcMain.handle('steam:lobbySetData', (_e, key, value) =>
    currentLobbyId ? steam.matchmaking.setLobbyData(currentLobbyId, key, value) : false);

ipcMain.handle('steam:lobbyGetData', (_e, key) =>
    currentLobbyId ? (steam.matchmaking.getLobbyData(currentLobbyId, key) || null) : null);

ipcMain.handle('steam:lobbyGetFullData', () =>
    currentLobbyId ? (steam.matchmaking.getAllLobbyData(currentLobbyId) ?? {}) : {});

ipcMain.handle('steam:lobbyMergeFullData', (_e, data) => {
    if (!currentLobbyId || !data) return false;
    let ok = true;
    for (const [k, v] of Object.entries(data)) {
        if (!steam.matchmaking.setLobbyData(currentLobbyId, k, String(v))) ok = false;
    }
    return ok;
});

ipcMain.handle('steam:lobbySetJoinable', (_e, flag) =>
    currentLobbyId ? steam.matchmaking.setLobbyJoinable(currentLobbyId, !!flag) : false);

ipcMain.handle('steam:lobbyOpenInviteDialog', () => {
    if (!steam || !currentLobbyId) return;
    try {
        steam.overlay.activateGameOverlayInviteDialog(currentLobbyId);
    } catch (e) {
        console.warn('[Steam] openInviteDialog failed:', e.message);
    }
});

ipcMain.handle('steam:lobbyGetLobbies', async () => {
    if (!steam) return [];
    try {
        const { ELobbyDistanceFilter } = steamEnums();
        steam.matchmaking.addRequestLobbyListDistanceFilter(
            ELobbyDistanceFilter?.Worldwide ?? 3,
        );
        steam.matchmaking.addRequestLobbyListResultCountFilter(50);
    } catch { /* optional filters */ }
    const result = await steam.matchmaking.requestLobbyList();
    if (!result?.success) return [];
    return (result.lobbies ?? []).map((id) => describeLobby(id));
});

// ── IPC: P2P networking (ISteamNetworkingSockets) ─────────────────────────────

ipcMain.handle('steam:netSend', (_e, steamId64Str, payload) => {
    if (!steam) return false;
    const steamId64 = String(steamId64Str);
    ensureListenSocket();
    const conn = ensureConnection(steamId64);
    if (conn == null) return false;
    return sendOnConnection(steamId64, payload);
});

// ── IPC: Storage ──────────────────────────────────────────────────────────────

ipcMain.handle('storage:readAll', (_e, file) => {
    const p = getSavePath(file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '{}';
});

ipcMain.handle('storage:writeAll', (_e, data, file) =>
    fs.writeFileSync(getSavePath(file), data, 'utf8'));

ipcMain.handle('storage:getPath', (_e, file) =>
    getSavePath(file));

// ── IPC: Window management ────────────────────────────────────────────────────

ipcMain.handle('win:close',          () => mainWin?.close());
ipcMain.handle('win:setFullscreen',  (_e, flag) => mainWin?.setFullScreen(flag));
// Player's UI-size multiplier. Kept out of the auto factor so a display change
// still rescales correctly underneath whatever the player picked.
ipcMain.handle('win:setUiScale',      (_e, factor) => {
    const f = Number(factor);
    uiScaleUser = Number.isFinite(f) && f > 0 ? Math.min(3, Math.max(0.25, f)) : 1;
    applyUiZoom();
});
ipcMain.handle('win:getUiScale',      () => uiScaleUser);
ipcMain.handle('win:isFullscreen',   () => mainWin?.isFullScreen() ?? false);
ipcMain.handle('win:nativeOverlayStatus', () => ({ ...nativeOverlayStatus }));
ipcMain.handle('win:setPosition',    (_e, pos) => mainWin?.setPosition(Math.round(pos.x), Math.round(pos.y)));
ipcMain.handle('win:setSize',        (_e, sz)  => mainWin?.setSize(Math.round(sz.width), Math.round(sz.height)));
ipcMain.handle('win:outerPosition',  () => { const [x, y] = mainWin?.getPosition() ?? [0, 0]; return { x, y }; });
ipcMain.handle('win:outerSize',      () => { const [width, height] = mainWin?.getSize() ?? [800, 600]; return { width, height }; });
// Packaged builds keep devtools off for players, but a shipped build is the
// only place some bugs appear (asar paths, install dirs with odd characters).
// Steam's Launch Options pass arguments rather than environment, so accept both.
const devtoolsAllowed = !app.isPackaged
    || process.env.STEAM_ELECTRON_DEVTOOLS === '1'
    || process.argv.includes('--devtools');
ipcMain.handle('win:openDevtools',   () => { if (devtoolsAllowed) mainWin?.webContents.openDevTools(); });

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

// ── IPC: LAN ──────────────────────────────────────────────────────────────────

ipcMain.handle('lan:isAvailable', () => lan.isAvailable());
ipcMain.handle('lan:startHost', (_e, options) => lan.startHost(options ?? {}));
ipcMain.handle('lan:stopHost', () => lan.stopHost());
ipcMain.handle('lan:updateHost', (_e, patch) => lan.updateHost(patch ?? {}));
ipcMain.handle('lan:listRooms', (_e, options) => lan.listRooms(options ?? {}));
ipcMain.handle('lan:getHostInfo', () => lan.getHostInfo());
