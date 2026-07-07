#!/usr/bin/env node
// Flattens electron-builder dir output so each platform folder is directly
// uploadable as a Steam depot:
//   dist-electron/mac/<ProductName>.app
//   dist-electron/win/<ProductName>.exe + support files
//   dist-electron/linux/<executableName> + support files
//
// Usage: node scripts/postbuild.js <mac|win|linux>

import { existsSync, readdirSync, renameSync, rmSync, statSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_NAME = pkg.build.productName;
const LINUX_BIN = pkg.build.linux.executableName;

const platform = process.argv[2];
if (!['mac', 'win', 'linux'].includes(platform)) {
    console.error('Usage: node scripts/postbuild.js <mac|win|linux>');
    process.exit(1);
}

const OUT = join(ROOT, `dist-electron/${platform}`);

function rm(p) {
    if (!existsSync(p)) return;
    rmSync(p, { recursive: true, force: true });
}

// electron-builder nests output in mac-arm64/, win-unpacked/, linux-unpacked/ — flatten it
const keep = platform === 'mac' ? `${PRODUCT_NAME}.app` : null;
const nestedDirs = readdirSync(OUT).filter(n =>
    statSync(join(OUT, n)).isDirectory() && n !== keep
);
for (const dir of nestedDirs) {
    const src = join(OUT, dir);
    for (const entry of readdirSync(src)) {
        const to = join(OUT, entry);
        rm(to); // overwrite leftovers from a previous build
        renameSync(join(src, entry), to);
    }
    rm(src);
}

// Sanity check: fail loudly in CI if the expected binary is missing
const expected = platform === 'mac' ? `${PRODUCT_NAME}.app`
    : platform === 'win' ? `${PRODUCT_NAME}.exe`
    : LINUX_BIN;
if (!existsSync(join(OUT, expected))) {
    console.error(`ERROR: expected "${expected}" not found in ${OUT}`);
    process.exit(1);
}

rm(join(OUT, 'builder-debug.yml'));
console.log(`postbuild [${platform}] done — ${expected} ready in dist-electron/${platform}`);
