/**
 * Demo game: up to 4 players move circles with gamepads.
 * Keyboard fallback: player 1 = WASD, player 2 = arrow keys.
 * F = fullscreen, Space = unlock test achievement (Spacewar app 480).
 */
import { Application, Graphics, Text } from 'pixi.js';
import { steam, toggleFullscreen } from 'steam-electron-build/native';

const PLAYER_COLORS = [0x00ffff, 0xaa00ff, 0xffe000, 0x00ff66];
const RADIUS = 32;
const SPEED = 6;

const app = new Application();
await app.init({ background: '#080820', resizeTo: window });
document.body.appendChild(app.canvas);

// ── Players ───────────────────────────────────────────────────────────────────

const players = PLAYER_COLORS.map((color, i) => {
    const circle = new Graphics().circle(0, 0, RADIUS).fill(color);
    circle.x = (i + 1) * (window.innerWidth / 5);
    circle.y = window.innerHeight / 2;
    circle.visible = i === 0; // others appear when their gamepad connects
    app.stage.addChild(circle);

    const label = new Text({
        text: `P${i + 1}`,
        style: { fill: 0x080820, fontSize: 20, fontWeight: 'bold' },
    });
    label.anchor.set(0.5);
    circle.addChild(label);

    return { circle, dx: 0, dy: 0 };
});

// ── Keyboard (players 1 + 2) ──────────────────────────────────────────────────

const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'f') toggleFullscreen();
    if (e.key === ' ') {
        steam.unlockAchievement('ACH_WIN_ONE_GAME'); // exists on Spacewar (480)
        status.text += '  [achievement sent]';
    }
});

function keyboardAxis(p, index) {
    if (index === 0) {
        p.dx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
        p.dy = (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0);
    } else if (index === 1) {
        p.dx = (keys.has('arrowright') ? 1 : 0) - (keys.has('arrowleft') ? 1 : 0);
        p.dy = (keys.has('arrowdown') ? 1 : 0) - (keys.has('arrowup') ? 1 : 0);
        if (p.dx || p.dy) p.circle.visible = true;
    }
}

// ── Game loop: poll gamepads, move circles ────────────────────────────────────

app.ticker.add(() => {
    const pads = navigator.getGamepads();
    players.forEach((p, i) => {
        p.dx = 0;
        p.dy = 0;

        const pad = pads[i];
        if (pad) {
            p.circle.visible = true;
            const [x, y] = pad.axes;
            if (Math.abs(x) > 0.15) p.dx = x;
            if (Math.abs(y) > 0.15) p.dy = y;
        }
        if (!p.dx && !p.dy) keyboardAxis(p, i);

        p.circle.x = Math.max(RADIUS, Math.min(app.screen.width - RADIUS, p.circle.x + p.dx * SPEED));
        p.circle.y = Math.max(RADIUS, Math.min(app.screen.height - RADIUS, p.circle.y + p.dy * SPEED));
    });
});

// ── Status line: shows Steam identity when running under Electron ────────────

const status = new Text({
    text: 'connecting…',
    style: { fill: 0x8888aa, fontSize: 16, fontFamily: 'monospace' },
});
status.position.set(12, 10);
app.stage.addChild(status);

const name = await steam.getUserName();
status.text = steam.isAvailable() && name
    ? `Steam: ${name}  |  connect gamepads to join  |  F fullscreen, Space achievement, Shift+Tab overlay`
    : 'Browser mode (no Steam)  |  connect gamepads to join  |  P1 WASD, P2 arrows, F fullscreen';
