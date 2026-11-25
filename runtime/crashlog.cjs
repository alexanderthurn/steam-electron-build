/**
 * Crash log + automatic crash reports — for the failures the game's own page
 * can't report: the whole app dying (a GPU crash on Linux, where the GPU runs
 * in-process), the renderer or GPU process going away, the page failing to
 * load, an error in the main process.
 *
 * Always on: a log file in userData/logs/ (main.log for this start, main.prev.log
 * for the one before) with the start-up facts (versions, OS, GPU, session type),
 * the main process's console, the page's warnings/errors and every process
 * event. Written synchronously, so the last line before a hard crash is there.
 *
 * Opt-in (steamElectronBuild.crashReportUrl): the reports are POSTed there as
 * JSON — { kind: 'crash', key, appVersion, platform, ts, data: { reason, ...,
 * logTail } }. Two ways in:
 *   - live: an event the main process survives (child/renderer gone, load
 *     failure, unresponsive page, main-process error) is sent right away;
 *   - next start: session.json is written at start and removed on a clean quit.
 *     Still there at the next start = the last run died without quitting (no
 *     handler runs then), so that start sends the previous run's log tail.
 * At most MAX_REPORTS per start; never throws, never blocks the game.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_MAX_BYTES = 2_000_000;   // one start's log; beyond it only a note
const TAIL_BYTES = 64_000;         // what a report carries of the log
const MAX_REPORTS = 5;
const SESSION_FILE = 'session.json';

let logPath = null;
let logBytes = 0;
let logCapped = false;
let reportUrl = null;
let reportsSent = 0;
let appVersion = '0.0.0';

const dirOf = () => path.join(app.getPath('userData'), 'logs');

function stamp() {
    return new Date().toISOString();
}

function fmt(args) {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

/** one line into main.log (synchronous: it must be on disk before a crash) */
function writeLog(level, text) {
    if (!logPath) return;
    try {
        if (logCapped) return;
        const line = `${stamp()} [${level}] ${text}\n`;
        if (logBytes + line.length > LOG_MAX_BYTES) {
            logCapped = true;
            fs.appendFileSync(logPath, `${stamp()} [log] size limit reached — later lines dropped\n`);
            return;
        }
        fs.appendFileSync(logPath, line);
        logBytes += line.length;
    } catch { /* a log must never break the app */ }
}

function tail(file) {
    try {
        const size = fs.statSync(file).size;
        const fd = fs.openSync(file, 'r');
        try {
            const len = Math.min(size, TAIL_BYTES);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len);
            return buf.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }
}

function linuxFacts() {
    if (process.platform !== 'linux') return {};
    let distro = '';
    try {
        const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
        distro = m?.[1] ?? '';
    } catch { /* none */ }
    const env = process.env;
    return {
        distro,
        sessionType: env.XDG_SESSION_TYPE ?? '',
        wayland: !!env.WAYLAND_DISPLAY,
        x11: !!env.DISPLAY,
        steamDeck: env.SteamDeck === '1',
        flatpak: fs.existsSync('/.flatpak-info'),
        // Steam Linux Runtime container (pressure-vessel)
        steamRuntime: !!(env.PRESSURE_VESSEL_RUNTIME || env.STEAM_RUNTIME || fs.existsSync('/run/pressure-vessel')),
        desktop: env.XDG_CURRENT_DESKTOP ?? '',
    };
}

function platformLine() {
    return `electron-main · ${process.platform} ${os.release()} ${process.arch}`
        + ` · electron ${process.versions.electron} · chrome ${process.versions.chrome}`;
}

/** POST one report (fire-and-forget) */
function report(key, data) {
    if (!reportUrl || reportsSent >= MAX_REPORTS) return;
    reportsSent++;
    try {
        const body = JSON.stringify({
            kind: 'crash',
            key,
            appVersion,
            platform: platformLine(),
            ts: Date.now(),
            data: { ...data, system: { ...linuxFacts(), cpus: os.cpus()?.[0]?.model ?? '', memGB: Math.round(os.totalmem() / 1e9) } },
        });
        fetch(reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
            .then((res) => writeLog('crashlog', `report "${key}" sent (${res.status})`))
            .catch((e) => writeLog('crashlog', `report "${key}" failed: ${e?.message ?? e}`));
    } catch { /* never */ }
}

/** something went wrong that the main process survived: log it, report it with the log so far */
function incident(key, data) {
    writeLog('incident', `${key} ${fmt([data])}`);
    report(key, { ...data, logTail: logPath ? tail(logPath) : '' });
}

/**
 * Call once, as early as possible (before app ready): opens the log, sends the
 * report of a previous run that died, hooks the main process's console and errors.
 */
function initCrashLog(cfg) {
    try {
        appVersion = app.getVersion();
        reportUrl = typeof cfg.crashReportUrl === 'string' && /^https:\/\//.test(cfg.crashReportUrl)
            ? cfg.crashReportUrl : null;
        const dir = dirOf();
        fs.mkdirSync(dir, { recursive: true });
        logPath = path.join(dir, 'main.log');
        const prevPath = path.join(dir, 'main.prev.log');
        try { fs.renameSync(logPath, prevPath); } catch { /* first start */ }

        // the last run never quit cleanly → report it with its log
        const sessionPath = path.join(app.getPath('userData'), SESSION_FILE);
        let lastSession = null;
        try { lastSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { /* clean */ }
        fs.writeFileSync(sessionPath, JSON.stringify({ started: Date.now(), version: appVersion, pid: process.pid }));
        app.on('will-quit', () => {
            writeLog('app', 'clean quit');
            try { fs.rmSync(sessionPath, { force: true }); } catch { /* gone */ }
        });

        writeLog('start', `${platformLine()} · app ${appVersion} · argv ${process.argv.slice(1).join(' ')}`);
        const facts = linuxFacts();
        if (Object.keys(facts).length) writeLog('start', fmt([facts]));

        if (lastSession) {
            writeLog('crashlog', `the previous run (started ${new Date(lastSession.started).toISOString()}) did not quit cleanly`);
            report('unclean-exit', {
                reason: 'the previous run ended without quitting (killed or crashed)',
                previous: lastSession,
                logTail: tail(prevPath),
            });
        }

        // the main process's own console into the log too
        for (const level of ['log', 'warn', 'error']) {
            const original = console[level].bind(console);
            console[level] = (...args) => {
                writeLog(level, fmt(args));
                original(...args);
            };
        }
        // monitor only: Electron's default handling (dialog) stays as it is
        process.on('uncaughtExceptionMonitor', (err, origin) => {
            incident('main-exception', { reason: origin, message: err?.message, stack: err?.stack });
        });
        process.on('unhandledRejection', (err) => {
            writeLog('error', `unhandled rejection: ${fmt([err])}`);
        });

        app.on('child-process-gone', (_e, d) => {
            if (d.reason === 'clean-exit') return;
            incident(`child-gone-${d.type}`, { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name, serviceName: d.serviceName });
        });
        app.whenReady().then(async () => {
            try {
                writeLog('gpu', fmt([app.getGPUFeatureStatus()]));
                const info = await app.getGPUInfo('basic');
                writeLog('gpu', fmt([{ devices: info?.gpuDevice, driver: info?.auxAttributes?.glRenderer ?? '' }]));
            } catch (e) { writeLog('gpu', `no GPU info: ${e?.message ?? e}`); }
        });
    } catch { /* the game must start even when this can't */ }
}

/** the game's window: its load, its renderer, its console warnings and errors */
function watchWindow(win) {
    try {
        const wc = win.webContents;
        wc.on('did-finish-load', () => writeLog('page', 'loaded'));
        wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
            if (!isMainFrame) return;
            incident('page-load-failed', { code, desc, url });
        });
        wc.on('render-process-gone', (_e, d) => {
            incident('renderer-gone', { reason: d.reason, exitCode: d.exitCode });
        });
        wc.on('preload-error', (_e, file, err) => {
            incident('preload-error', { file, message: err?.message, stack: err?.stack });
        });
        win.on('unresponsive', () => incident('page-unresponsive', {}));
        win.on('responsive', () => writeLog('page', 'responsive again'));
        wc.on('console-message', (e, legacyLevel, legacyMessage, legacyLine, legacySource) => {
            // Electron ≥ 35: one event object; older: positional (level 0..3)
            const level = typeof e?.level === 'string' ? e.level : ['debug', 'info', 'warning', 'error'][legacyLevel] ?? 'info';
            if (level !== 'warning' && level !== 'error') return;
            const message = e?.message ?? legacyMessage ?? '';
            const where = e?.sourceId ?? legacySource ?? '';
            const line = e?.lineNumber ?? legacyLine ?? '';
            writeLog(`page-${level}`, `${message}${where ? ` (${path.basename(where)}:${line})` : ''}`);
        });
    } catch { /* never */ }
}

module.exports = { initCrashLog, watchWindow, crashLog: writeLog };
