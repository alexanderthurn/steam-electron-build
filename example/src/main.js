/**
 * Demo game: FPS stress test for Steam overlay modes.
 * Players: WASD / arrows / gamepads. F fullscreen, Esc quit, Space achievement.
 * =/+ spawn complex mouse-swarm orbs, - despawn, 0 clear.
 */
import {
    Application,
    Graphics,
    Text,
    Container,
    Filter,
    GlProgram,
    BlurFilter,
    defaultFilterVert,
} from 'pixi.js';
import { steam, toggleFullscreen, win } from 'steam-electron-build/native';

const PLAYER_COLORS = [0x00ffff, 0xaa00ff, 0xffe000, 0x00ff66];
const ORB_COLORS = [0xff3366, 0x33ffcc, 0xffcc33, 0x66aaff, 0xff66ff, 0xff8844];
const RADIUS = 36;
const SPEED = 6;
const SPAWN_BATCH = 4;
const START_ENTITIES = 6;
const SPARKS_PER_ORB = 10;
const TRAIL_LEN = 8;
const FPS_SAMPLE_MS = 500;

const app = new Application();
await app.init({
    background: '#020208',
    resizeTo: window,
    antialias: false,
    preference: 'webgl',
});
document.body.appendChild(app.canvas);

const bgLayer = new Container();
const world = new Container();
const stressLayer = new Container();
const uiLayer = new Container();
app.stage.addChild(bgLayer, world, stressLayer, uiLayer);

// Shared blur on the whole stress layer — cost scales with orb count / coverage,
// but the opaque cores stay readable (unlike broken per-entity custom filters).
stressLayer.filters = [new BlurFilter({ strength: 3, quality: 3, kernelSize: 7 })];

// ── Fullscreen plasma background ──────────────────────────────────────────────

const plasmaFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;
uniform vec2 uResolution;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 8; i++) {
        v += a * noise(p);
        p = m * p;
        a *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
    uv.x *= uResolution.x / max(uResolution.y, 1.0);
    vec2 q = vec2(fbm(uv * 2.5 + uTime * 0.12), fbm(uv * 2.5 + vec2(5.2, 1.3)));
    vec2 r = vec2(
        fbm(uv * 2.5 + 3.5 * q + uTime * 0.09),
        fbm(uv * 2.5 + 3.5 * q + vec2(8.3, 2.8))
    );
    float f = fbm(uv * 2.5 + 3.5 * r);
    vec3 col = mix(vec3(0.02, 0.03, 0.10), vec3(0.12, 0.04, 0.28), clamp(f * f * 3.5, 0.0, 1.0));
    col = mix(col, vec3(0.0, 0.45, 0.6), clamp(length(q) * 0.8, 0.0, 1.0));
    col = mix(col, vec3(0.85, 0.25, 0.45), clamp(length(r) * 0.7, 0.0, 1.0));
    finalColor = vec4(col, 1.0);
}
`;

const plasmaFilter = new Filter({
    glProgram: GlProgram.from({
        vertex: defaultFilterVert,
        fragment: plasmaFrag,
        name: 'plasma-bg',
    }),
    resources: {
        plasmaUniforms: {
            uTime: { value: 0, type: 'f32' },
            uResolution: { value: [1, 1], type: 'vec2<f32>' },
        },
    },
});

const bg = new Graphics().rect(0, 0, 100, 100).fill(0x101028);
bg.filters = [plasmaFilter];
bgLayer.addChild(bg);

function syncBgSize() {
    const w = app.screen.width;
    const h = app.screen.height;
    if (w < 2 || h < 2) return;
    bg.clear().rect(0, 0, w, h).fill(0x101028);
    plasmaFilter.resources.plasmaUniforms.uniforms.uResolution = [w, h];
}
syncBgSize();
window.addEventListener('resize', syncBgSize);
win.onResized(() => requestAnimationFrame(syncBgSize));

const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
});

// ── Players — multi-ring “reactor” look ───────────────────────────────────────

function buildPlayer(color, index) {
    const root = new Container();
    root.x = (index + 1) * (window.innerWidth / 5);
    root.y = window.innerHeight / 2;
    root.visible = index === 0;

    const aura = new Graphics();
    const ringA = new Graphics();
    const ringB = new Graphics();
    const core = new Graphics();
    const spokes = new Graphics();
    root.addChild(aura, ringA, ringB, spokes, core);

    const label = new Text({
        text: `P${index + 1}`,
        style: { fill: 0x061018, fontSize: 18, fontWeight: 'bold' },
    });
    label.anchor.set(0.5);
    root.addChild(label);

    world.addChild(root);
    return { root, aura, ringA, ringB, spokes, core, color, phase: Math.random() * Math.PI * 2, dx: 0, dy: 0 };
}

function paintPlayer(p, t) {
    const { aura, ringA, ringB, spokes, core, color, phase } = p;
    const pulse = 0.85 + 0.15 * Math.sin(t * 3 + phase);
    const r = RADIUS * pulse;

    aura.clear()
        .circle(0, 0, r * 2.1).fill({ color, alpha: 0.12 })
        .circle(0, 0, r * 1.55).fill({ color, alpha: 0.22 });

    ringA.clear();
    for (let i = 0; i < 3; i++) {
        const a0 = t * 1.4 + phase + (i * Math.PI * 2) / 3;
        ringA.arc(0, 0, r * 1.25, a0, a0 + 0.9)
            .stroke({ width: 3, color: 0xffffff, alpha: 0.75 });
    }

    ringB.clear();
    for (let i = 0; i < 4; i++) {
        const a0 = -t * 0.9 + phase * 0.5 + (i * Math.PI * 2) / 4;
        ringB.arc(0, 0, r * 1.05, a0, a0 + 0.55)
            .stroke({ width: 2, color, alpha: 0.9 });
    }

    spokes.clear();
    for (let i = 0; i < 6; i++) {
        const a = t * 0.7 + phase + (i / 6) * Math.PI * 2;
        spokes.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35)
            .lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95)
            .stroke({ width: 2, color: 0xffffff, alpha: 0.35 });
    }

    core.clear()
        .circle(0, 0, r * 0.72).fill({ color, alpha: 1 })
        .circle(0, 0, r * 0.38).fill({ color: 0xffffff, alpha: 0.9 })
        .circle(0, 0, r * 0.16).fill({ color, alpha: 1 })
        .circle(0, 0, r * 0.85).stroke({ width: 2, color: 0xffffff, alpha: 0.5 });
}

const players = PLAYER_COLORS.map((color, i) => buildPlayer(color, i));

// ── Stress orbs — trails + sparks + star core (CPU/GPU heavy, still visible) ──

const entities = [];

function makeEntity() {
    const color = ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0];
    const size = 16 + Math.random() * 18;
    const root = new Container();
    const trail = new Graphics();
    const body = new Graphics();
    const sparks = [];
    root.addChild(trail, body);

    for (let i = 0; i < SPARKS_PER_ORB; i++) {
        const s = new Graphics()
            .circle(0, 0, 2 + Math.random() * 3)
            .fill({ color: 0xffffff, alpha: 0.85 });
        root.addChild(s);
        sparks.push({
            g: s,
            a: Math.random() * Math.PI * 2,
            d: size * (0.9 + Math.random() * 1.4),
            speed: 0.04 + Math.random() * 0.08,
        });
    }

    const ang = Math.random() * Math.PI * 2;
    const dist = 50 + Math.random() * 100;
    root.x = mouse.x + Math.cos(ang) * dist;
    root.y = mouse.y + Math.sin(ang) * dist;
    stressLayer.addChild(root);

    return {
        root,
        trail,
        body,
        sparks,
        size,
        color,
        angle: ang,
        orbit: dist,
        orbitSpeed: (0.025 + Math.random() * 0.05) * (Math.random() < 0.5 ? 1 : -1),
        wobble: Math.random() * Math.PI * 2,
        pull: 0.05 + Math.random() * 0.07,
        history: [],
    };
}

function paintOrbBody(body, color, size, t) {
    body.clear();
    const spikes = 8;
    const pts = [];
    for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2 + t;
        const r = i % 2 === 0 ? size : size * 0.45;
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
    }
    body.poly(pts).fill({ color, alpha: 0.95 });
    body.circle(0, 0, size * 0.55).fill({ color: 0xffffff, alpha: 0.85 });
    body.circle(0, 0, size * 0.22).fill({ color, alpha: 1 });
    body.circle(0, 0, size * 1.15).stroke({ width: 2, color: 0xffffff, alpha: 0.65 });
    for (let i = 0; i < 5; i++) {
        const a = t * 2 + (i / 5) * Math.PI * 2;
        body.circle(Math.cos(a) * size * 0.7, Math.sin(a) * size * 0.7, 2.5)
            .fill({ color: 0xffffff, alpha: 0.8 });
    }
}

function spawnEntities(n) {
    for (let i = 0; i < n; i++) entities.push(makeEntity());
    refreshHud();
}

function despawnEntities(n) {
    const drop = Math.min(n, entities.length);
    for (let i = 0; i < drop; i++) {
        const e = entities.pop();
        e.root.destroy({ children: true });
    }
    refreshHud();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'f') toggleFullscreen();
    if (e.key === 'Escape') win.close();
    if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
        spawnEntities(SPAWN_BATCH);
    }
    if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
        despawnEntities(SPAWN_BATCH);
    }
    if (e.key === '0' || e.code === 'Digit0') despawnEntities(entities.length);
    if (e.key === ' ') {
        steam.unlockAchievement('ACH_WIN_ONE_GAME');
        hintFlashUntil = performance.now() + 1200;
        refreshHud();
    }
});

function keyboardAxis(p, index) {
    if (index === 0) {
        p.dx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
        p.dy = (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0);
    } else if (index === 1) {
        p.dx = (keys.has('arrowright') ? 1 : 0) - (keys.has('arrowleft') ? 1 : 0);
        p.dy = (keys.has('arrowdown') ? 1 : 0) - (keys.has('arrowup') ? 1 : 0);
        if (p.dx || p.dy) p.root.visible = true;
    }
}

// ── HUD ───────────────────────────────────────────────────────────────────────

const nativeMode = win.isNativeOverlay();
const modeLabel = nativeMode ? 'overlay' : 'friends';
let attachLine = nativeMode ? 'ATTACH  waiting…' : 'ATTACH  n/a (friends mode)';
const otherCmd = nativeMode ? 'npm run friends' : 'npm run overlay';
const shiftTabLabel = nativeMode ? 'Overlay (probe)' : 'Friends';
let hintFlashUntil = 0;
let fpsDisplay = 0;
let msDisplay = 0;
let fpsAccum = 0;
let msAccum = 0;
let fpsFrames = 0;
let fpsLastSample = performance.now();
let frameStart = performance.now();

const hudStyle = {
    fill: 0xf0f0ff,
    fontSize: 15,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: 22,
};

const hud = new Text({ text: '', style: hudStyle });
hud.position.set(12, 10);
uiLayer.addChild(hud);

const keysHelp = new Text({
    text: [
        '+  Spawn',
        '-  Despawn',
        'F  Fullscreen',
        'Esc  Quit',
        `Shift+Tab  ${shiftTabLabel}`,
    ].join('\n'),
    style: hudStyle,
});
uiLayer.addChild(keysHelp);

function placeKeysHelp() {
    const pad = 12;
    keysHelp.position.set(pad, Math.max(pad, app.screen.height - keysHelp.height - pad));
}
placeKeysHelp();
window.addEventListener('resize', placeKeysHelp);
win.onResized(() => requestAnimationFrame(placeKeysHelp));

const name = await steam.getUserName();
const steamLine = steam.isAvailable() && name
    ? `Steam: ${name}`
    : 'Browser mode (no Steam)';

function refreshHud() {
    const ach = performance.now() < hintFlashUntil ? '  [achievement sent]' : '';
    const lines = [
        `PROBE  ${modeLabel}  —  ${nativeMode ? 'native mirror on this machine' : 'programmatic activateOverlay'}`,
        `other  ${otherCmd}`,
        attachLine,
        `FPS ${fpsDisplay}   ${msDisplay}ms   orbs ${entities.length}${ach}`,
        steamLine,
    ];
    hud.text = lines.join('\n');
}

function applyOverlayStatus(status) {
    if (!status?.requested) {
        attachLine = 'ATTACH  n/a (friends mode)';
    } else if (status.attached) {
        attachLine = `ATTACH  ok  (${status.platform})  —  try Shift+Tab`;
    } else if (status.error) {
        attachLine = `ATTACH  FAIL  ${status.error}`;
    } else if (status.available === false) {
        attachLine = 'ATTACH  FAIL  isOverlayAvailable() false';
    } else {
        attachLine = 'ATTACH  waiting…';
    }
    refreshHud();
}

if (nativeMode) {
    win.nativeOverlayStatus().then(applyOverlayStatus);
    win.onNativeOverlayStatus?.(applyOverlayStatus);
}

spawnEntities(START_ENTITIES);

// ── Game loop ─────────────────────────────────────────────────────────────────

app.ticker.add((ticker) => {
    const dt = ticker.deltaTime;
    const now = performance.now();
    const frameMs = now - frameStart;
    frameStart = now;
    const t = now * 0.001;

    fpsAccum += ticker.FPS;
    msAccum += frameMs;
    fpsFrames += 1;
    if (now - fpsLastSample >= FPS_SAMPLE_MS) {
        fpsDisplay = Math.round(fpsAccum / Math.max(1, fpsFrames));
        msDisplay = Math.round(msAccum / Math.max(1, fpsFrames));
        fpsAccum = 0;
        msAccum = 0;
        fpsFrames = 0;
        fpsLastSample = now;
        refreshHud();
    }

    plasmaFilter.resources.plasmaUniforms.uniforms.uTime = t;

    const pads = navigator.getGamepads();
    players.forEach((p, i) => {
        p.dx = 0;
        p.dy = 0;
        const pad = pads[i];
        if (pad) {
            p.root.visible = true;
            const [x, y] = pad.axes;
            if (Math.abs(x) > 0.15) p.dx = x;
            if (Math.abs(y) > 0.15) p.dy = y;
        }
        if (!p.dx && !p.dy) keyboardAxis(p, i);
        p.root.x = Math.max(RADIUS, Math.min(app.screen.width - RADIUS, p.root.x + p.dx * SPEED));
        p.root.y = Math.max(RADIUS, Math.min(app.screen.height - RADIUS, p.root.y + p.dy * SPEED));
        paintPlayer(p, t);
    });

    for (const e of entities) {
        e.angle += e.orbitSpeed * dt;
        e.wobble += 0.08 * dt;
        e.orbit = 55 + 100 * (0.5 + 0.5 * Math.sin(e.wobble));
        const tx = mouse.x + Math.cos(e.angle) * e.orbit;
        const ty = mouse.y + Math.sin(e.angle) * e.orbit;
        e.root.x += (tx - e.root.x) * e.pull * dt;
        e.root.y += (ty - e.root.y) * e.pull * dt;

        e.history.push({ x: e.root.x, y: e.root.y });
        if (e.history.length > TRAIL_LEN) e.history.shift();

        // Motion trail — redrawn every frame (real CPU cost that stays visible).
        e.trail.clear();
        for (let i = 0; i < e.history.length; i++) {
            const h = e.history[i];
            const a = ((i + 1) / e.history.length) * 0.45;
            const r = e.size * (0.25 + 0.55 * ((i + 1) / e.history.length));
            e.trail.circle(h.x - e.root.x, h.y - e.root.y, r).fill({ color: e.color, alpha: a });
        }

        paintOrbBody(e.body, e.color, e.size, t + e.wobble);

        for (const s of e.sparks) {
            s.a += s.speed * dt;
            s.g.x = Math.cos(s.a) * s.d;
            s.g.y = Math.sin(s.a) * s.d;
            s.g.alpha = 0.45 + 0.55 * Math.sin(t * 4 + s.a);
        }

        e.root.scale.set(0.9 + 0.15 * Math.sin(e.wobble * 1.5));
    }
});
