const { contextBridge, ipcRenderer } = require('electron');

// ── Steam API ─────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('steam', {
    getUserName:             () => ipcRenderer.invoke('steam:getUserName'),
    getSteamId:              () => ipcRenderer.invoke('steam:getSteamId'),
    getAvatarDataUrl:        () => ipcRenderer.invoke('steam:getAvatarDataUrl'),
    getAppId:                () => ipcRenderer.invoke('steam:getAppId'),
    getCurrentBetaName:      () => ipcRenderer.invoke('steam:getCurrentBetaName'),
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
    setUiScale:        (f)    => ipcRenderer.invoke('win:setUiScale', f),
    getUiScale:        ()     => ipcRenderer.invoke('win:getUiScale'),
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
    readAll:  (file)       => ipcRenderer.invoke('storage:readAll', file),
    writeAll: (data, file) => ipcRenderer.invoke('storage:writeAll', data, file),
    getPath:  (file)       => ipcRenderer.invoke('storage:getPath', file),
});

// ── Open URL ──────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('openUrl', (url) => ipcRenderer.invoke('openUrl', url));

// ── LAN (PeerJS signaling host + UDP discovery; no-op unless config.lan) ──────

contextBridge.exposeInMainWorld('electronLan', {
    isAvailable: () => ipcRenderer.invoke('lan:isAvailable'),
    startHost:   (options) => ipcRenderer.invoke('lan:startHost', options),
    stopHost:    () => ipcRenderer.invoke('lan:stopHost'),
    updateHost:  (patch) => ipcRenderer.invoke('lan:updateHost', patch),
    listRooms:   (options) => ipcRenderer.invoke('lan:listRooms', options),
    getHostInfo: () => ipcRenderer.invoke('lan:getHostInfo'),
});

// ── Key handlers ──────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('keydown', (e) => {
        // Steam expects Shift+Tab to open the overlay; the Electron hook doesn't
        // always catch it, so trigger it manually.
        if (e.shiftKey && e.key === 'Tab') {
            e.preventDefault();
            // Must use ipcRenderer here: contextIsolation means window.steam
            // (exposeInMainWorld) is only visible to the page, not preload.
            ipcRenderer.invoke('steam:activateOverlay', 'Friends');
        }
        // F11 / Alt+Enter toggle fullscreen — the conventional game bindings.
        // Reuses the existing channels; main remembers the new state for the
        // next launch. Games can still drive this themselves via electronWin.
        // macOS binds F11 to volume/Show Desktop, so it never reaches us there —
        // Ctrl+Cmd+F is the platform's own fullscreen shortcut.
        const macFullscreen = e.ctrlKey && e.metaKey && (e.key === 'f' || e.key === 'F');
        if (e.key === 'F11' || (e.altKey && e.key === 'Enter') || macFullscreen) {
            e.preventDefault();
            ipcRenderer.invoke('win:isFullscreen')
                .then((on) => ipcRenderer.invoke('win:setFullscreen', !on));
        }
        // F12 opens devtools (main process ignores this in packaged builds).
        if (e.key === 'F12') {
            e.preventDefault();
            ipcRenderer.invoke('win:openDevtools');
        }
    }, true);
});
