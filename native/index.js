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
    /** Steam beta branch name, or null / '' when on the default (public) branch */
    getCurrentBetaName: () => window.steam?.getCurrentBetaName?.() ?? Promise.resolve(null),
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
    close:         () => window.electronWin?.close() ?? Promise.resolve(),
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
    async load() {
        if (window.electronStorage) return JSON.parse(await window.electronStorage.readAll());
        return JSON.parse(localStorage.getItem('save') ?? '{}');
    },
    async save(data) {
        const json = JSON.stringify(data);
        if (window.electronStorage) return window.electronStorage.writeAll(json);
        localStorage.setItem('save', json);
    },
};

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
