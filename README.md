# pixi-steam-template

PixiJS v8 game wrapped with Electron for Steam. Develop in the browser, ship a native build to Steam — Windows, macOS, Linux/Steam Deck.

Extracted from a shipped Steam game ([DICEPTION](https://store.steampowered.com/app/3689240/)), so the annoying parts are already solved:

- **Steam overlay** (Shift+Tab) works, including the manual trigger fallback
- **Steam Linux Runtime fixes** — `LD_LIBRARY_PATH` ordering, sandbox/zygote switches, clean process exit so Steam detects the game closing
- **Achievements & stats** wired through IPC with a browser no-op fallback
- **CI** builds all three platforms and uploads straight to Steamworks

The included demo: up to 4 players move colored circles with gamepads (keyboard fallback: P1 = WASD, P2 = arrows). `F` toggles fullscreen, `Space` unlocks a test achievement, `Shift+Tab` opens the Steam overlay.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Browser dev server with hot reload (Steam calls are no-ops) |
| `npm start` | Build + run the real Electron app (Steam works if the Steam client is running) |
| `npm run build:mac` / `build:win` / `build:linux` | Depot-ready folder in `dist-electron/<platform>/` |

The default app id is **480 (Spacewar)**, Valve's public test app — Steam integration works out of the box on any machine with Steam running, no Steamworks account needed. The `Space` key unlocks Spacewar's `ACH_WIN_ONE_GAME` achievement as a smoke test.

## Starting a new game from this template

1. Copy the repo (or "Use this template" on GitHub)
2. Edit `package.json`: `name`, `version`, `steamAppId`, and the `build` block (`appId`, `productName`, `linux.executableName`)
3. Replace `build/icon.png` (512×512 — electron-builder derives all platform icons from it)
4. Write your game in `src/` — talk to Steam/window/saves only through `src/native.js`

## Architecture

```
src/            your game (pixi.js). Imports src/native.js, never Electron directly
src/native.js   bridge: steam / win / storage / openUrl — no-ops in plain browser
electron/       main.cjs (steamworks.js + IPC handlers), preload.cjs (contextBridge)
scripts/        postbuild.js — flattens electron-builder output into depot folders
```

`steamworks.js` ships the Steam redistributable libraries inside its npm package (kept outside the asar via `asarUnpack`), so there is no Steamworks SDK download step — `npm ci` is the whole setup, locally and in CI.

Saves: one JSON file in the app-data dir (`storage.load()` / `storage.save()` in `native.js`); localStorage in the browser. Point Steam Cloud auto-sync at it if you want cloud saves.

## Steam release setup (once per game)

1. In the [Steamworks partner portal](https://partner.steamgames.com/): note your **app id** and create three **depots** (Windows, macOS, Linux)
2. In the workflow `.github/workflows/build.yml`, the depots map in order: `depot1Path` = win, `depot2` = mac, `depot3` = linux — Steamworks depot ids must be appid+1, +2, +3 (the game-ci/steam-deploy convention) or adjust the workflow
3. Add GitHub repo secrets:
   - `STEAM_USERNAME` — Steamworks build account
   - `STEAM_CONFIG_VDF` — see [game-ci/steam-deploy](https://github.com/game-ci/steam-deploy#configvdf) for how to generate it
   - `STEAM_APP_ID` — your app id
   - `STEAM_RELEASE_BRANCH` — e.g. `prerelease`
4. Push a tag: `git tag v1.0.0 && git push --tags` — CI builds all platforms and pushes the build to Steam

`workflow_dispatch` is also enabled, so you can run builds from the Actions tab without tagging (build artifacts only, no Steam upload).

## Steam Deck notes

The Linux build runs inside the Steam Linux Runtime. `electron/main.cjs` applies the required switches (`no-sandbox`, `no-zygote`, `in-process-gpu`, `disable-dev-shm-usage`) and prepends the bundled `libsteam_api.so` to `LD_LIBRARY_PATH` before `steamworks.js` loads — don't remove these, they look arbitrary but each one fixes a real Steam Deck failure.
