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
    unlockAchievement:  (id) => window.steam?.unlockAchievement(id) ?? Promise.resolve(),
    getUnlockedAchievements: (ids) => window.steam?.getUnlockedAchievements(ids) ?? Promise.resolve([]),
    getStat:            (name) => window.steam?.getStatI32(name) ?? Promise.resolve(0),
    setStat:            (name, value) => window.steam?.setStat(name, value) ?? Promise.resolve(),
    activateOverlay:    (dialog) => window.steam?.activateOverlay(dialog) ?? Promise.resolve(),
    openStore:          () => window.steam?.openStore() ?? Promise.resolve(),
    quit:               () => window.steam?.quit() ?? Promise.resolve(),
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
