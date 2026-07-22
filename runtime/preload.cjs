const { contextBridge, ipcRenderer } = require('electron');

// ── Steam API ─────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('steam', {
    getUserName:             () => ipcRenderer.invoke('steam:getUserName'),
    getSteamId:              () => ipcRenderer.invoke('steam:getSteamId'),
    getAppId:                () => ipcRenderer.invoke('steam:getAppId'),
    isDev:                   () => ipcRenderer.invoke('steam:isDev'),
    quit:                    () => ipcRenderer.invoke('steam:quit'),
    activateOverlay:         (dialog) => ipcRenderer.invoke('steam:activateOverlay', dialog || 'Friends'),
    openStore:               () => ipcRenderer.invoke('steam:openStore'),
    unlockAchievement:       (id) => ipcRenderer.invoke('steam:unlockAchievement', id),
    getUnlockedAchievements: (ids) => ipcRenderer.invoke('steam:getUnlockedAchievements', ids),
    getStatI32:              (name) => ipcRenderer.invoke('steam:getStatI32', name),
    setStat:                 (name, value) => ipcRenderer.invoke('steam:setStat', name, value),
    clearAchievement:        (id) => ipcRenderer.invoke('steam:clearAchievement', id),
    resetAllStats:           (achievementsToo) => ipcRenderer.invoke('steam:resetAllStats', achievementsToo),
    lobby: {
        create:            (type, maxMembers) => ipcRenderer.invoke('steam:lobbyCreate', type, maxMembers),
        join:              (lobbyId)          => ipcRenderer.invoke('steam:lobbyJoin', lobbyId),
        leave:             ()                 => ipcRenderer.invoke('steam:lobbyLeave'),
        getMembers:        ()                 => ipcRenderer.invoke('steam:lobbyGetMembers'),
        getOwner:          ()                 => ipcRenderer.invoke('steam:lobbyGetOwner'),
        setData:           (key, value)       => ipcRenderer.invoke('steam:lobbySetData', key, value),
        getData:           (key)              => ipcRenderer.invoke('steam:lobbyGetData', key),
        getFullData:       ()                 => ipcRenderer.invoke('steam:lobbyGetFullData'),
        mergeFullData:     (data)             => ipcRenderer.invoke('steam:lobbyMergeFullData', data),
        setJoinable:       (flag)             => ipcRenderer.invoke('steam:lobbySetJoinable', flag),
        openInviteDialog:  ()                 => ipcRenderer.invoke('steam:lobbyOpenInviteDialog'),
        getLobbies:        ()                 => ipcRenderer.invoke('steam:lobbyGetLobbies'),
        onChatUpdate:      (cb) => ipcRenderer.on('steam:lobbyChatUpdate', (_e, data) => cb(data)),
        onJoinRequested:   (cb) => ipcRenderer.on('steam:lobbyJoinRequested', (_e, data) => cb(data)),
    },
    net: {
        send:   (steamId64, payload) => ipcRenderer.invoke('steam:netSend', steamId64, payload),
        onData: (cb) => ipcRenderer.on('steam:p2pData', (_e, data) => cb(data)),
    },
});

// ── Window management ─────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronWin', {
    close:             ()     => ipcRenderer.invoke('win:close'),
    setFullscreen:     (flag) => ipcRenderer.invoke('win:setFullscreen', flag),
    isFullscreen:      ()     => ipcRenderer.invoke('win:isFullscreen'),
    setPosition:       (pos)  => ipcRenderer.invoke('win:setPosition', pos),
    setSize:           (size) => ipcRenderer.invoke('win:setSize', size),
    outerPosition:     ()     => ipcRenderer.invoke('win:outerPosition'),
    outerSize:         ()     => ipcRenderer.invoke('win:outerSize'),
    getMonitors:       ()     => ipcRenderer.invoke('win:getMonitors'),
    getCurrentMonitor: ()     => ipcRenderer.invoke('win:getCurrentMonitor'),
    onMoved:           (cb)   => ipcRenderer.on('win:moved', (_e, data) => cb(data)),
    onResized:         (cb)   => ipcRenderer.on('win:resized', (_e, data) => cb(data)),
});

// ── Storage ───────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronStorage', {
    readAll:  ()     => ipcRenderer.invoke('storage:readAll'),
    writeAll: (data) => ipcRenderer.invoke('storage:writeAll', data),
    getPath:  ()     => ipcRenderer.invoke('storage:getPath'),
});

// ── Open URL ──────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('openUrl', (url) => ipcRenderer.invoke('openUrl', url));

// ── Key handlers ──────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('keydown', (e) => {
        // Steam expects Shift+Tab to open the overlay; the Electron hook doesn't
        // always catch it, so trigger it manually.
        if (e.shiftKey && e.key === 'Tab') {
            e.preventDefault();
            window.steam?.activateOverlay('Friends');
        }
        // F12 opens devtools (main process ignores this in packaged builds).
        if (e.key === 'F12') {
            e.preventDefault();
            ipcRenderer.invoke('win:openDevtools');
        }
    }, true);
});
