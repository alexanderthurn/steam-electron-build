#!/usr/bin/env node
// steam-electron-build — wrap a built web game (dist/) in Electron + Steamworks.
//
//   steam-electron-build dev            run the game in Electron with live Steam
//   steam-electron-build build <os>     depot-ready folder in dist-electron/<os>  (mac|win|linux)
//
// Configuration is read from the game's package.json "steamElectronBuild" block —
// every field is optional, defaults work out of the box (Steam test app 480).

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');      // the steam-electron-build package
const PROJECT = process.cwd();                    // the game project

// Resolve dependencies from the game project first, then from this package.
// Needed because with a symlinked install (file:/link:) node would otherwise
// resolve from this file's real path, outside the game's node_modules tree.
function resolveDep(spec) {
    return require.resolve(spec, { paths: [PROJECT, PKG_ROOT] });
}

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
    const pkgPath = path.join(PROJECT, 'package.json');
    if (!fs.existsSync(pkgPath)) fail(`no package.json in ${PROJECT}`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const c = pkg.steamElectronBuild ?? {};

    const productName = c.productName ?? pkg.name ?? 'game';
    const slug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const iconRel = c.icon ?? 'icon.png';
    const iconPath = fs.existsSync(path.join(PROJECT, iconRel))
        ? path.join(PROJECT, iconRel)
        : path.join(PKG_ROOT, 'assets', 'icon.png');

    const extendPath = path.join(PROJECT, c.extend ?? 'steam-electron-build.extend.cjs');

    return {
        productName,
        version: pkg.version ?? '0.0.0',
        appId: c.appId ?? `com.example.${slug.replace(/-/g, '')}`,
        steamAppId: c.steamAppId ?? 480,
        executableName: c.executableName ?? slug,
        distDir: path.join(PROJECT, c.dist ?? 'dist'),
        iconPath,
        extendPath: fs.existsSync(extendPath) ? extendPath : null,
        hasWebBuild: !!pkg.scripts?.build,
        // Opt-in LAN PeerServer + UDP discovery (default off — no open ports).
        lan: c.lan === true,
        // Without this the option is honoured only in packaged builds, where cfg
        // comes straight from package.json rather than through this function.
        fullscreen: c.fullscreen,
        lanDiscoveryPort: c.lanDiscoveryPort,
        // Off by default: universal roughly doubles mac depot size and build
        // time, and only matters once Intel Macs are worth supporting.
        macUniversal: c.macUniversal === true,
    };
}

function fail(msg) {
    console.error(`steam-electron-build: ${msg}`);
    process.exit(1);
}

// Locate a package's own package.json. Packages with an "exports" map that does
// not list "./package.json" (peer@1, for one) make the direct resolve throw, so
// fall back to resolving the entry point and walking up to the package root.
function resolvePkgJson(name) {
    try {
        return resolveDep(`${name}/package.json`);
    } catch (e) {
        if (e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e;
    }
    let dir = path.dirname(resolveDep(name));
    while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)
            && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) return candidate;
        dir = path.dirname(dir);
    }
    throw Object.assign(new Error(`cannot locate package.json for ${name}`), { code: 'MODULE_NOT_FOUND' });
}

/** Copy an npm package and its production dependency tree into destNodeModules. */
function copyPackageTree(name, destNodeModules, seen = new Set()) {
    if (seen.has(name)) return;
    seen.add(name);
    let pkgJsonPath;
    try {
        pkgJsonPath = resolvePkgJson(name);
    } catch {
        console.warn(`steam-electron-build: optional dep "${name}" not found — skipped`);
        return;
    }
    const from = path.dirname(pkgJsonPath);
    const to = path.join(destNodeModules, ...name.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
        // Skip optional native / peer-only noise that peer lists but we don't need at runtime
        if (dep.startsWith('@types/')) continue;
        copyPackageTree(dep, destNodeModules, seen);
    }
}

// ── Web build ─────────────────────────────────────────────────────────────────

function webBuild(cfg) {
    if (cfg.hasWebBuild) {
        console.log('steam-electron-build: running npm run build');
        execSync('npm run build', { cwd: PROJECT, stdio: 'inherit' });
    }
    if (!fs.existsSync(path.join(cfg.distDir, 'index.html'))) {
        fail(`no index.html in ${cfg.distDir} — build your game first or set steamElectronBuild.dist`);
    }
}

// ── dev: run Electron straight from the package ───────────────────────────────

function resolveSteamSdkDir() {
    // Prefer the game project's steamworks_sdk, then this package's copy.
    const candidates = [
        path.join(PROJECT, 'steamworks_sdk'),
        path.join(PKG_ROOT, 'steamworks_sdk'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(path.join(p, 'redistributable_bin'))) return p;
    }
    return null;
}

function dev(cfg) {
    webBuild(cfg);
    try {
        cfg.steamFfiPath = path.dirname(resolveDep('steamworks-ffi-node/package.json'));
    } catch { /* runtime will warn that Steam is unavailable */ }
    cfg.packageRoot = PKG_ROOT;
    cfg.steamSdkPath = resolveSteamSdkDir();
    if (!cfg.steamSdkPath) {
        console.warn('steam-electron-build: no steamworks_sdk/redistributable_bin found — Steam will be disabled');
        console.warn('  Place Valve\'s redistributable_bin under steamworks_sdk/ (game or package root).');
    }
    const electron = require(resolveDep('electron')); // resolves to the binary path
    const env = { ...process.env, STEAM_ELECTRON_BUILD_CONFIG: JSON.stringify(cfg) };
    // Cursor/CI sometimes set this; if left on, Electron runs the main script as
    // plain Node and `require('electron').app` is undefined.
    delete env.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(electron, [path.join(PKG_ROOT, 'runtime', 'main.cjs')], {
        cwd: PROJECT,
        stdio: 'inherit',
        env,
    });
    process.exit(res.status ?? 0);
}

// ── build: stage app, run electron-builder, flatten to depot layout ───────────

async function build(cfg, platform) {
    if (!['mac', 'win', 'linux'].includes(platform)) {
        fail(`unknown platform "${platform}" — use mac, win or linux`);
    }
    webBuild(cfg);

    // Stage a minimal Electron app: game dist + runtime + icon + steamworks-ffi-node
    const stage = path.join(PROJECT, '.steam-electron-build');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, 'build'), { recursive: true });
    fs.cpSync(cfg.distDir, path.join(stage, 'dist'), { recursive: true });
    fs.cpSync(path.join(PKG_ROOT, 'runtime'), path.join(stage, 'electron'), { recursive: true });
    fs.cpSync(cfg.iconPath, path.join(stage, 'build', 'icon.png'));
    if (cfg.extendPath) fs.cpSync(cfg.extendPath, path.join(stage, 'electron', 'extend.cjs'));

    const ffiPkg = resolveDep('steamworks-ffi-node/package.json'); // throws if missing
    copyPackageTree('steamworks-ffi-node', path.join(stage, 'node_modules'));
    // koffi (FFI) + optional native overlay prebuilds travel with the tree above.

    const sdkDir = resolveSteamSdkDir();
    if (!sdkDir) {
        fail('steamworks_sdk/redistributable_bin required for packaged Steam builds');
    }
    fs.cpSync(sdkDir, path.join(stage, 'steamworks_sdk'), { recursive: true });

    const stageDeps = { 'steamworks-ffi-node': require(ffiPkg).version };
    if (cfg.lan) {
        // PeerServer + transitive deps (express, ws, …) — only when LAN is opted in
        copyPackageTree('peer', path.join(stage, 'node_modules'));
        stageDeps.peer = require(resolvePkgJson('peer')).version;
    }

    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
        name: cfg.executableName,
        version: cfg.version,
        main: 'electron/main.cjs',
        dependencies: stageDeps,
        steamElectronBuild: {
            productName: cfg.productName,
            appId: cfg.appId,
            steamAppId: cfg.steamAppId,
            lan: cfg.lan === true,
            ...(cfg.lanDiscoveryPort ? { lanDiscoveryPort: cfg.lanDiscoveryPort } : {}),
        },
    }, null, 2));

    const out = path.join(PROJECT, 'dist-electron', platform);
    fs.rmSync(out, { recursive: true, force: true });

    const builder = require(resolveDep('electron-builder'));
    const targets = {
        mac: builder.Platform.MAC,
        win: builder.Platform.WINDOWS,
        linux: builder.Platform.LINUX,
    };
    const extraResources = [
        { from: 'steamworks_sdk', to: 'steamworks_sdk' },
        { from: 'build/icon.png', to: 'icon.png' },
    ];
    // With macUniversal the mac depot carries x64 + arm64 so it also runs on
    // Intel Macs; otherwise every platform follows the build machine's arch.
    await builder.build({
        targets: platform === 'mac' && cfg.macUniversal
            ? targets.mac.createTarget('dir', builder.Arch.universal)
            : targets[platform].createTarget('dir'),
        projectDir: stage,
        config: {
            appId: cfg.appId,
            productName: cfg.productName,
            electronVersion: require(resolveDep('electron/package.json')).version,
            directories: { output: out },
            files: ['dist/**', 'electron/**', 'node_modules/**'],
            asarUnpack: [
                'node_modules/steamworks-ffi-node/**',
                'node_modules/koffi/**',
                // koffi 3.x ships its .node in a sibling @koromix/koffi-* package
                'node_modules/@koromix/**',
            ],
            extraResources,
            icon: 'build/icon.png',
            mac: {
                identity: null,
                // koffi (and other prebuilt natives) ship every arch in arch-named
                // folders, so the same .node appears in both halves of a universal
                // build. @electron/universal cannot classify those on its own —
                // taking one copy is correct precisely because they are identical.
                x64ArchFiles: '**/*.node',
                // Needed for Metal overlay mirroring on macOS (ffi-node overlay).
                entitlements: path.join(PKG_ROOT, 'assets', 'entitlements.mac.plist'),
                entitlementsInherit: path.join(PKG_ROOT, 'assets', 'entitlements.mac.plist'),
            },
            win: { target: 'dir' },
            linux: {
                target: 'dir',
                executableName: cfg.executableName,
            },
        },
    });

    flatten(out, cfg, platform);
    console.log(`steam-electron-build: depot-ready build in dist-electron/${platform}/`);
}

// electron-builder nests output in mac-arm64/, win-unpacked/, linux-unpacked/ —
// flatten so the folder is directly uploadable as a Steam depot.
function flatten(out, cfg, platform) {
    const keep = platform === 'mac' ? `${cfg.productName}.app` : null;
    const dirs = fs.readdirSync(out)
        .filter(d => fs.statSync(path.join(out, d)).isDirectory());
    // A universal mac build leaves its per-arch inputs (mac-arm64/, mac-x64/)
    // beside the merged mac-universal/ — hoisting all of them would clobber the
    // merged app with an arch-specific one, so drop everything but the merge.
    const merged = platform === 'mac' ? dirs.find(d => d.endsWith('-universal')) : null;
    for (const dir of dirs) {
        const src = path.join(out, dir);
        if (dir === keep) continue;
        if (merged && dir !== merged) {
            fs.rmSync(src, { recursive: true, force: true });
            continue;
        }
        for (const entry of fs.readdirSync(src)) {
            const to = path.join(out, entry);
            fs.rmSync(to, { recursive: true, force: true });
            fs.renameSync(path.join(src, entry), to);
        }
        fs.rmSync(src, { recursive: true, force: true });
    }
    fs.rmSync(path.join(out, 'builder-debug.yml'), { force: true });

    const expected = platform === 'mac' ? `${cfg.productName}.app`
        : platform === 'win' ? `${cfg.productName}.exe`
        : cfg.executableName;
    if (!fs.existsSync(path.join(out, expected))) {
        fail(`expected "${expected}" not found in ${out}`);
    }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const [cmd, arg] = positional;
const cfg = loadConfig();
const wantNativeOverlay = flags.has('--overlay')
    || process.env.STEAM_ELECTRON_NATIVE_OVERLAY === '1';

const OS_SHORTCUTS = ['mac', 'win', 'linux'];

if (cmd === 'dev') {
    if (wantNativeOverlay) {
        process.env.STEAM_ELECTRON_NATIVE_OVERLAY = '1';
        console.log('steam-electron-build: native Steam overlay probe enabled (--overlay)');
    }
    dev(cfg);
} else if (cmd === 'build' || OS_SHORTCUTS.includes(cmd)) {
    // `steam-electron-build mac` is shorthand for `steam-electron-build build mac`
    build(cfg, cmd === 'build' ? arg : cmd).catch((e) => fail(e.stack ?? String(e)));
} else {
    console.log(`steam-electron-build — wrap a web game in Electron + Steamworks

Usage:
  steam-electron-build dev            run the game in Electron (Steam works if the client is running)
  steam-electron-build dev --overlay  native mirror probe (all platforms)
  steam-electron-build build <os>     depot-ready build in dist-electron/<os>   (mac | win | linux)
  steam-electron-build <os>           shorthand for build <os>

Config (all optional) in your package.json:
  "steamElectronBuild": {
    "productName": "My Game",         // default: package name
    "appId": "com.studio.mygame",     // bundle identifier
    "steamAppId": 480,                // default: 480 (Spacewar test app)
    "executableName": "mygame",       // linux binary name
    "dist": "dist",                   // your web build output
    "icon": "icon.png",               // 512x512 png
    "extend": "steam-electron-build.extend.cjs" // optional main-process hook
  }`);
    process.exit(cmd ? 1 : 0);
}
