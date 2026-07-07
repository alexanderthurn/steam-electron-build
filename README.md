# steam-electron-build

Ship any HTML5/WebGL game to Steam with Electron — PixiJS, Phaser, Three.js, vanilla, anything that builds to a `dist/` folder. One command on your machine, the same command in CI.

```bash
npm i -D steam-electron-build
npx steam-electron-build dev          # your game in Electron, with real Steam
npx steam-electron-build win          # depot-ready folder in dist-electron/win  (mac | win | linux)
```

No config needed to start: it defaults to Steam's public test app **480 (Spacewar)**, so Steam integration works on any machine with the Steam client running — no Steamworks account, no SDK download (`steamworks.js` bundles the redistributables).

Extracted from a shipped Steam game ([DICEPTION](https://store.steampowered.com/app/3689240/)), so the annoying parts are already solved:

- **Steam overlay** (Shift+Tab), including the manual trigger fallback
- **Achievements, stats, player identity** exposed to your game as `window.steam`
- **Steam Deck / Steam Linux Runtime fixes** — library path ordering, sandbox/zygote switches, clean process exit so Steam notices the game closed
- **Cloud-syncable JSON save file** in the platform app-data dir
- **GitHub Actions**: a reusable workflow that builds all three platforms and uploads to Steamworks

## Requirements

- Node 22+
- Steam client installed and running (only for testing Steam features — without it the game still runs)

## Try the example

A PixiJS v8 demo lives in [`example/`](example): up to 4 players move circles with gamepads (keyboard fallback: WASD / arrows), `F` fullscreen, `Space` unlocks a test achievement, `Shift+Tab` opens the overlay.

```bash
npm install      # the package's own deps (only needed for the file:.. link)
cd example
npm install
npm start        # = steam-electron-build dev
```

## Using it in your game

Your game keeps being a normal web project. Steam features are available two ways:

**Globals** (no import, any framework): the preload script injects `window.steam`, `window.electronStorage`, `window.electronWin`, `window.openUrl` — all `undefined` in a plain browser, so guard with `?.`.

**Or the helper module** (safe no-ops in the browser, so `vite dev` keeps working untouched):

```js
import { steam, storage, toggleFullscreen, openUrl } from 'steam-electron-build/native';

const name = await steam.getUserName();        // '' in browser
await steam.unlockAchievement('ACH_FIRST_WIN');
await steam.setStat('STAT_GAMES_PLAYED', 42);

await storage.save({ level: 3 });              // JSON file under Electron, localStorage in browser
const data = await storage.load();
```

### Config

All optional, in your `package.json`:

```jsonc
"steamElectronBuild": {
  "productName": "My Game",          // default: package name
  "appId": "com.studio.mygame",      // bundle identifier (also the save folder name)
  "steamAppId": 1234567,             // default: 480 (Spacewar)
  "executableName": "mygame",        // linux binary name
  "dist": "dist",                    // your web build output dir
  "icon": "icon.png",                // 512x512 png (all platform icons derive from it)
  "extend": "steam-electron-build.extend.cjs"  // optional main-process hook, see below
}
```

`steam-electron-build dev` and `steam-electron-build build` run your `npm run build` first if the script exists, then wrap whatever is in the dist dir.

### Escape hatch

If your game needs a custom IPC handler or direct `steamworks.js` access, put a `steam-electron-build.extend.cjs` next to your package.json — it runs in the Electron main process:

```js
module.exports = ({ app, ipcMain, getSteam, getWindow }) => {
    ipcMain.handle('my:thing', () => getSteam()?.localplayer.getLevel());
};
```

## GitHub Actions

Add one file to your game repo, `.github/workflows/steam.yml`:

```yaml
name: Steam
on:
  push:
    tags: ['v*']
  workflow_dispatch:
jobs:
  steam:
    uses: alexanderthurn/steam-electron-build/.github/workflows/steam.yml@main
    secrets: inherit
```

Every run builds Windows, macOS and Linux and uploads them as artifacts. On a `v*` tag it additionally publishes to Steam via [game-ci/steam-deploy](https://github.com/game-ci/steam-deploy) — set these repo secrets:

| Secret | Value |
|---|---|
| `STEAM_USERNAME` | Steamworks build account |
| `STEAM_CONFIG_VDF` | see the [steam-deploy docs](https://github.com/game-ci/steam-deploy#configvdf) |
| `STEAM_APP_ID` | your app id |
| `STEAM_RELEASE_BRANCH` | e.g. `prerelease` |

Depot mapping follows the steam-deploy convention: depot ids appid+1 (win), +2 (mac), +3 (linux). Since CI just runs `npx steam-electron-build build`, a CI build and a local build are identical by construction.

## Steam release checklist (once per game)

1. Steamworks partner portal: create the app + three depots (win/mac/linux)
2. Set `steamAppId` in your `steamElectronBuild` config
3. Add the workflow + secrets above
4. `git tag v1.0.0 && git push --tags`

## Steam Deck notes

The Linux build runs inside the Steam Linux Runtime. The runtime applies the required Electron switches (`no-sandbox`, `no-zygote`, `in-process-gpu`, `disable-dev-shm-usage`) and prepends the bundled `libsteam_api.so` to `LD_LIBRARY_PATH` before `steamworks.js` loads. These look arbitrary but each one fixes a real Steam Deck failure — they're the main reason this package exists.

## License

MIT
