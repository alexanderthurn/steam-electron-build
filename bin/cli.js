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
    };
}

function fail(msg) {
    console.error(`steam-electron-build: ${msg}`);
    process.exit(1);
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

function dev(cfg) {
    webBuild(cfg);
    const electron = require('electron'); // resolves to the binary path
    const res = spawnSync(electron, [path.join(PKG_ROOT, 'runtime', 'main.cjs')], {
        cwd: PROJECT,
        stdio: 'inherit',
        env: { ...process.env, STEAM_ELECTRON_BUILD_CONFIG: JSON.stringify(cfg) },
    });
    process.exit(res.status ?? 0);
}

// ── build: stage app, run electron-builder, flatten to depot layout ───────────

async function build(cfg, platform) {
    if (!['mac', 'win', 'linux'].includes(platform)) {
        fail(`unknown platform "${platform}" — use mac, win or linux`);
    }
    webBuild(cfg);

    // Stage a minimal Electron app: game dist + runtime + icon + steamworks.js
    const stage = path.join(PROJECT, '.steam-electron-build');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, 'build'), { recursive: true });
    fs.cpSync(cfg.distDir, path.join(stage, 'dist'), { recursive: true });
    fs.cpSync(path.join(PKG_ROOT, 'runtime'), path.join(stage, 'electron'), { recursive: true });
    fs.cpSync(cfg.iconPath, path.join(stage, 'build', 'icon.png'));
    if (cfg.extendPath) fs.cpSync(cfg.extendPath, path.join(stage, 'electron', 'extend.cjs'));

    // steamworks.js ships prebuilt binaries — just copy it (and its type-only
    // deps, which electron-builder wants present to resolve the tree) in
    for (const dep of ['steamworks.js', '@types/node', 'undici-types']) {
        try {
            const from = path.dirname(require.resolve(`${dep}/package.json`, { paths: [PKG_ROOT] }));
            fs.cpSync(from, path.join(stage, 'node_modules', dep), { recursive: true });
        } catch { /* optional sub-dep not installed — fine */ }
    }

    const swVersion = require('steamworks.js/package.json').version;
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
        name: cfg.executableName,
        version: cfg.version,
        main: 'electron/main.cjs',
        dependencies: { 'steamworks.js': swVersion },
        steamElectronBuild: {
            productName: cfg.productName,
            appId: cfg.appId,
            steamAppId: cfg.steamAppId,
        },
    }, null, 2));

    const out = path.join(PROJECT, 'dist-electron', platform);
    fs.rmSync(out, { recursive: true, force: true });

    const builder = require('electron-builder');
    const targets = {
        mac: builder.Platform.MAC,
        win: builder.Platform.WINDOWS,
        linux: builder.Platform.LINUX,
    };
    await builder.build({
        targets: targets[platform].createTarget('dir'),
        projectDir: stage,
        config: {
            appId: cfg.appId,
            productName: cfg.productName,
            electronVersion: require('electron/package.json').version,
            directories: { output: out },
            files: ['dist/**', 'electron/**'],
            asarUnpack: ['node_modules/steamworks.js/**'],
            icon: 'build/icon.png',
            mac: { identity: null },
            win: { target: 'dir' },
            linux: {
                target: 'dir',
                executableName: cfg.executableName,
                extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
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
    for (const dir of fs.readdirSync(out)) {
        const src = path.join(out, dir);
        if (!fs.statSync(src).isDirectory() || dir === keep) continue;
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

const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();

if (cmd === 'dev') {
    dev(cfg);
} else if (cmd === 'build') {
    build(cfg, arg).catch((e) => fail(e.stack ?? String(e)));
} else {
    console.log(`steam-electron-build — wrap a web game in Electron + Steamworks

Usage:
  steam-electron-build dev            run the game in Electron (Steam works if the client is running)
  steam-electron-build build <os>     depot-ready build in dist-electron/<os>   (mac | win | linux)

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
