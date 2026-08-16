/**
 * native.js — the only file that talks to Electron.
 * In a plain browser (vite dev server) every call is a safe no-op,
 * so the game code never needs to know where it's running.
 */

export const isElectron = () => !!window.electronWin;

// ── Steam ─────────────────────────────────────────────────────────────────────

export const steam = {
    isAvailable:        () => !!window.steam,
    getUserName:        () => window.steam?.getUserName() ?? Promise.resolve(''),
    getSteamId:         () => window.steam?.getSteamId() ?? Promise.resolve('0'),
    /** Local player's Steam avatar as a data URL, or null */
    getAvatarDataUrl:   () => window.steam?.getAvatarDataUrl?.() ?? Promise.resolve(null),
    /** Steam beta branch name, or null / '' when on the default (public) branch */
    getCurrentBetaName: () => window.steam?.getCurrentBetaName?.() ?? Promise.resolve(null),
    /** App id we were launched as — differs from the configured one under a playtest or demo; 0 outside Steam. */
    getAppId:           () => window.steam?.getAppId?.() ?? Promise.resolve(0),
    unlockAchievement:  (id) => window.steam?.unlockAchievement(id) ?? Promise.resolve(),
    getUnlockedAchievements: (ids) => window.steam?.getUnlockedAchievements(ids) ?? Promise.resolve([]),
    getStat:            (name) => window.steam?.getStatI32(name) ?? Promise.resolve(0),
    setStat:            (name, value) => window.steam?.setStat(name, value) ?? Promise.resolve(),
    activateOverlay:    (dialog) => window.steam?.activateOverlay(dialog) ?? Promise.resolve(),
    openStore:          () => window.steam?.openStore() ?? Promise.resolve(),
    quit:               () => window.steam?.quit() ?? Promise.resolve(),
};

// ── Steam lobbies + P2P networking ─────────────────────────────────────────────
// `type`: 'private' (invite-only — a direct friend invite) or 'public'
// (discoverable via getLobbies — anonymous quick-match). Every id (lobby,
// steamId64) is a decimal string, never a bigint or number — large enough to
// lose precision as a JS number, and safest as a plain string across the
// Electron IPC boundary either way.

export const lobby = {
    isAvailable:      () => !!window.steam?.lobby,
    create:           (type, maxMembers) => window.steam?.lobby.create(type, maxMembers) ?? Promise.resolve(null),
    join:             (lobbyId) => window.steam?.lobby.join(lobbyId) ?? Promise.resolve(null),
    leave:            () => window.steam?.lobby.leave() ?? Promise.resolve(),
    getMembers:       () => window.steam?.lobby.getMembers() ?? Promise.resolve([]),
    getOwner:         () => window.steam?.lobby.getOwner() ?? Promise.resolve(null),
    setData:          (key, value) => window.steam?.lobby.setData(key, value) ?? Promise.resolve(false),
    getData:          (key) => window.steam?.lobby.getData(key) ?? Promise.resolve(null),
    getFullData:      () => window.steam?.lobby.getFullData() ?? Promise.resolve({}),
    mergeFullData:    (data) => window.steam?.lobby.mergeFullData(data) ?? Promise.resolve(false),
    setJoinable:      (flag) => window.steam?.lobby.setJoinable(flag) ?? Promise.resolve(false),
    openInviteDialog: () => window.steam?.lobby.openInviteDialog() ?? Promise.resolve(),
    getLobbies:       () => window.steam?.lobby.getLobbies() ?? Promise.resolve([]),
    /** fires on any member joining/leaving the current lobby */
    onChatUpdate:     (cb) => window.steam?.lobby.onChatUpdate(cb),
    /** fires when the user accepts a Steam overlay/friends-list "Join Game" invite */
    onJoinRequested:  (cb) => window.steam?.lobby.onJoinRequested(cb),
};

export const net = {
    isAvailable: () => !!window.steam?.net,
    /** payload is any JSON-serializable value — this layer only moves bytes */
    send:        (steamId64, payload) => window.steam?.net.send(steamId64, payload) ?? Promise.resolve(false),
    /** cb(({ steamId64, data }) => …) for every inbound packet, from any sender */
    onData:      (cb) => window.steam?.net.onData(cb),
};

// ── Window ────────────────────────────────────────────────────────────────────

export const win = {
    setFullscreen: (flag) => window.electronWin?.setFullscreen(flag) ?? Promise.resolve(),
    isFullscreen:  () => window.electronWin?.isFullscreen() ?? Promise.resolve(false),
    /** Multiplier on the automatic high-DPI zoom — 1 leaves it as computed. */
    setUiScale:    (factor) => window.electronWin?.setUiScale?.(factor) ?? Promise.resolve(),
    getUiScale:    () => window.electronWin?.getUiScale?.() ?? Promise.resolve(1),
    close:         () => window.electronWin?.close() ?? Promise.resolve(),
    /** true when launched with steamworks-ffi-node's mirrored native overlay */
    isNativeOverlay: () => !!window.electronWin?.isNativeOverlay?.(),
    /** { requested, attached, available, platform, error } — for overlay probe HUD */
    nativeOverlayStatus: () => window.electronWin?.nativeOverlayStatus?.()
        ?? Promise.resolve({ requested: false, attached: false, available: null, platform: null, error: null }),
    onNativeOverlayStatus: (cb) => window.electronWin?.onNativeOverlayStatus?.(cb),
    onMoved:       (cb) => window.electronWin?.onMoved?.(cb),
    onResized:     (cb) => window.electronWin?.onResized?.(cb),
};

export async function toggleFullscreen() {
    if (isElectron()) {
        win.setFullscreen(!(await win.isFullscreen()));
    } else if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        document.documentElement.requestFullscreen();
    }
}

// ── Storage (JSON save file under Electron, localStorage in browser) ──────────

export const storage = {
    /** `file` names a file in the app-data dir (default save.json), so a Steam
     *  Auto-Cloud rule can match some kinds of state and skip others. */
    async load(file) {
        if (window.electronStorage) return JSON.parse(await window.electronStorage.readAll(file));
        return JSON.parse(localStorage.getItem(file ? `save:${file}` : 'save') ?? '{}');
    },
    async save(data, file) {
        const json = JSON.stringify(data);
        if (window.electronStorage) return window.electronStorage.writeAll(json, file);
        localStorage.setItem(file ? `save:${file}` : 'save', json);
    },
};

// ── Cloud-mirrored localStorage ───────────────────────────────────────────────
// Games keep using localStorage; this copies it into the save file (which Steam
// Auto-Cloud syncs) and back. Generic on purpose: it mirrors every key matching
// a prefix, so settings added later need no extra wiring.

/** Where the mirror lives inside the save file, kept apart from game state. */
const MIRROR_FIELD = 'localStorage';

/**
 * Mirror localStorage into the cloud-synced save file.
 *
 * The file wins at startup (Steam has already pulled a newer copy down before
 * launch); memory wins for the rest of the session. That is right for one
 * machine at a time — simultaneous play on two machines needs real merge rules.
 *
 * Safe no-op in a browser, where there is no save file to sync.
 *
 * @param {{ file?: string, prefix?: string, excludePrefix?: string, exclude?: string[], debounceMs?: number }} [options]
 * @returns {Promise<boolean>} true when mirroring is active
 */
export async function mirrorLocalStorage({ file, prefix = '', excludePrefix, exclude = [], debounceMs = 400 } = {}) {
    if (!window.electronStorage) return false;

    // excludePrefix carves a whole namespace out — so a second mirror can own
    // e.g. every `<prefix>user-` key without this one listing them individually,
    // which would otherwise put each newly added key in both files.
    const mirrored = (key) => key.startsWith(prefix)
        && !(excludePrefix && key.startsWith(excludePrefix))
        && !exclude.includes(key);

    // A half-written or corrupt file must never take the game down with it —
    // callers await this during startup. Treat it as empty: local data stands,
    // and the next write repairs the file.
    const read = async () => {
        try {
            return await storage.load(file);
        } catch {
            return {};
        }
    };

    const stored = await read();
    for (const [key, value] of Object.entries(stored?.[MIRROR_FIELD] ?? {})) {
        if (mirrored(key) && typeof value === 'string') localStorage.setItem(key, value);
    }

    const snapshot = () => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && mirrored(key)) out[key] = localStorage.getItem(key);
        }
        return out;
    };

    let timer = null;
    const flush = async () => {
        timer = null;
        // Re-read so a concurrent writer's other fields survive our update.
        const current = await read();
        await storage.save({ ...current, [MIRROR_FIELD]: snapshot(), mirroredAt: Date.now() }, file);
    };
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flush(), debounceMs);
    };

    const nativeSet = localStorage.setItem.bind(localStorage);
    const nativeRemove = localStorage.removeItem.bind(localStorage);
    const nativeClear = localStorage.clear.bind(localStorage);
    localStorage.setItem = (key, value) => {
        nativeSet(key, value);
        if (mirrored(key)) schedule();
    };
    localStorage.removeItem = (key) => {
        nativeRemove(key);
        if (mirrored(key)) schedule();
    };
    localStorage.clear = () => {
        nativeClear();
        schedule();
    };

    // A debounced write can still be pending when the window goes away.
    window.addEventListener('pagehide', () => {
        if (timer) {
            clearTimeout(timer);
            void flush();
        }
    });

    return true;
}

// ── Open URL ──────────────────────────────────────────────────────────────────

export function openUrl(url) {
    if (window.openUrl) window.openUrl(url);
    else window.open(url, '_blank');
}

// ── LAN (opt-in: steamElectronBuild.lan === true) ─────────────────────────────
// Host starts a local PeerServer + UDP announce; guests listRooms() then
// connect with PeerJS: new Peer(room.peerId, { host: room.host, port: room.port, path: room.path }).
// Safe no-ops in the browser and when the feature flag is off.

/** @typedef {{
 *   name: string,
 *   peerId: string,
 *   host: string,
 *   port: number,
 *   path: string,
 *   maxPlayers: number | null,
 *   data: Record<string, unknown>,
 * }} LanRoom */

export const lan = {
    /** true when Electron AND steamElectronBuild.lan === true */
    isAvailable: () => window.electronLan?.isAvailable() ?? Promise.resolve(false),
    /**
     * @param {{ name?: string, peerId?: string, port?: number, path?: string, maxPlayers?: number | null, data?: Record<string, unknown> }} [options]
     * @returns {Promise<LanRoom | null>}
     */
    startHost: (options) => window.electronLan?.startHost(options) ?? Promise.resolve(null),
    stopHost: () => window.electronLan?.stopHost() ?? Promise.resolve(),
    /**
     * @param {{ name?: string, peerId?: string, maxPlayers?: number | null, data?: Record<string, unknown> }} [patch]
     * @returns {Promise<LanRoom | null>}
     */
    updateHost: (patch) => window.electronLan?.updateHost(patch) ?? Promise.resolve(null),
    /**
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<LanRoom[]>}
     */
    listRooms: (options) => window.electronLan?.listRooms(options) ?? Promise.resolve([]),
    /** @returns {Promise<LanRoom | null>} */
    getHostInfo: () => window.electronLan?.getHostInfo() ?? Promise.resolve(null),
};
