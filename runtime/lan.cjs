/**
 * LAN discovery + local PeerJS signaling for offline / LAN-party play.
 *
 * Opt-in via steamElectronBuild.lan === true. When disabled, createLan()
 * returns a stub that never opens ports.
 *
 * Discovery: UDP broadcast (CS-style query/announce), filtered by appId.
 * Also queries 127.0.0.1 so two Electron instances on one PC find each other
 * (LAN broadcast often does not loop back to other local processes).
 * Signaling: PeerServer on the host; games use PeerJS client against host/port/path.
 */

const dgram = require('dgram');
const http = require('http');
const net = require('net');
const os = require('os');
const express = require('express');

const MAGIC = 'seb-lan';
const PROTOCOL = 1;
const DEFAULT_PEER_PORT = 9000;
const DEFAULT_PEER_PATH = '/peerjs';
const DEFAULT_DISCOVERY_PORT = 41234;
const ANNOUNCE_MS = 1000;
const DEFAULT_LIST_TIMEOUT_MS = 2000;

function primaryLanIPv4() {
    let ifaces;
    try {
        ifaces = os.networkInterfaces();
    } catch {
        return '127.0.0.1';
    }
    for (const list of Object.values(ifaces)) {
        for (const info of list ?? []) {
            if (info.family !== 'IPv4' && info.family !== 4) continue;
            if (info.internal) continue;
            return info.address;
        }
    }
    return '127.0.0.1';
}

function encodeMsg(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8');
}

function decodeMsg(buf) {
    try {
        const obj = JSON.parse(buf.toString('utf8'));
        if (!obj || obj.magic !== MAGIC || obj.v !== PROTOCOL) return null;
        return obj;
    } catch {
        return null;
    }
}

function broadcastAddresses() {
    const out = new Set(['255.255.255.255']);
    let ifaces;
    try {
        ifaces = os.networkInterfaces();
    } catch {
        return [...out];
    }
    for (const list of Object.values(ifaces)) {
        for (const info of list ?? []) {
            if ((info.family !== 'IPv4' && info.family !== 4) || info.internal) continue;
            if (!info.address || !info.netmask) continue;
            const ip = info.address.split('.').map(Number);
            const mask = info.netmask.split('.').map(Number);
            if (ip.length !== 4 || mask.length !== 4) continue;
            const bcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
            out.add(bcast);
        }
    }
    return [...out];
}

/** Prefer an explicit port, otherwise first free port from `start` upward. */
function findFreePort(preferred) {
    const start = preferred && preferred > 0 ? preferred : DEFAULT_PEER_PORT;
    return new Promise((resolve, reject) => {
        let port = start;
        const max = start + 64;
        const tryOnce = () => {
            if (port > max) {
                reject(new Error(`No free port in ${start}–${max}`));
                return;
            }
            const probe = net.createServer();
            probe.once('error', () => {
                port += 1;
                tryOnce();
            });
            probe.listen(port, '0.0.0.0', () => {
                probe.close((err) => {
                    if (err) reject(err);
                    else resolve(port);
                });
            });
        };
        tryOnce();
    });
}

/**
 * @param {{ enabled: boolean, appId: string, discoveryPort?: number }} opts
 */
function createLan(opts) {
    const enabled = !!opts.enabled;
    const appId = String(opts.appId || 'game');
    const discoveryPort = Number(opts.discoveryPort) || DEFAULT_DISCOVERY_PORT;

    /** @type {import('http').Server | null} */
    let httpServer = null;
    /** @type {import('dgram').Socket | null} */
    let advertiseSock = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let announceTimer = null;
    /** @type {null | {
     *   name: string,
     *   peerId: string,
     *   host: string,
     *   port: number,
     *   path: string,
     *   maxPlayers: number | null,
     *   data: Record<string, unknown>,
     * }} */
    let room = null;

    function isAvailable() {
        return enabled;
    }

    function getHostInfo() {
        return room ? { ...room } : null;
    }

    function announcePayload() {
        if (!room) return null;
        return {
            magic: MAGIC,
            v: PROTOCOL,
            t: 'announce',
            appId,
            name: room.name,
            peerId: room.peerId,
            host: room.host,
            port: room.port,
            path: room.path,
            maxPlayers: room.maxPlayers,
            data: room.data,
        };
    }

    function sendAnnounce(sock, targetAddr, targetPort) {
        const payload = announcePayload();
        if (!payload || !sock) return;
        const buf = encodeMsg(payload);
        const port = targetPort ?? discoveryPort;
        if (targetAddr) {
            try {
                sock.send(buf, port, targetAddr);
            } catch {
                /* ignore */
            }
            return;
        }
        // Localhost: two Electron apps on one PC (broadcast often doesn't loop back)
        try {
            sock.send(buf, port, '127.0.0.1');
        } catch {
            /* ignore */
        }
        for (const addr of broadcastAddresses()) {
            try {
                sock.send(buf, port, addr);
            } catch {
                /* ignore */
            }
        }
    }

    async function startHost(options = {}) {
        if (!enabled) return null;
        await stopHost();

        const name = String(options.name ?? '').trim() || 'Host';
        const peerId = String(options.peerId ?? name).trim() || name;
        const path = String(options.path || DEFAULT_PEER_PATH);
        const maxPlayers = options.maxPlayers == null ? null : Number(options.maxPlayers);
        const data = options.data && typeof options.data === 'object' ? { ...options.data } : {};
        const host = primaryLanIPv4();

        let port;
        try {
            port = await findFreePort(Number(options.port) || DEFAULT_PEER_PORT);
        } catch (e) {
            console.warn('[LAN] No free PeerServer port:', e.message);
            return null;
        }

        let ExpressPeerServer;
        try {
            ({ ExpressPeerServer } = require('peer'));
        } catch (e) {
            console.warn('[LAN] peer package missing — cannot start PeerServer:', e.message);
            return null;
        }

        const app = express();
        httpServer = http.createServer(app);
        const peerMount = path.endsWith('/') ? path.slice(0, -1) : path;
        const peerServer = ExpressPeerServer(httpServer, { path: '/' });
        app.use(peerMount || '/peerjs', peerServer);

        try {
            await new Promise((resolve, reject) => {
                const onErr = (err) => {
                    httpServer.off('listening', onListening);
                    reject(err);
                };
                const onListening = () => {
                    httpServer.off('error', onErr);
                    resolve();
                };
                httpServer.once('error', onErr);
                httpServer.once('listening', onListening);
                httpServer.listen(port, '0.0.0.0');
            });
        } catch (e) {
            console.warn('[LAN] PeerServer listen failed:', e.message);
            try {
                httpServer.close();
            } catch {
                /* ignore */
            }
            httpServer = null;
            return null;
        }

        room = { name, peerId, host, port, path: peerMount || '/peerjs', maxPlayers, data };

        // Held locally as well as on `advertiseSock`, and it is the LOCAL one
        // every handler and the timer below use: they belong to this host
        // generation and must not start serving a later one just because the
        // shared variable moved on (see stopHost).
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        advertiseSock = sock;
        sock.on('error', (err) => {
            console.warn('[LAN] advertise socket error:', err.message);
        });
        sock.on('message', (msg, rinfo) => {
            const parsed = decodeMsg(msg);
            if (!parsed || parsed.appId !== appId) return;
            if (parsed.t === 'query') sendAnnounce(sock, rinfo.address, rinfo.port);
        });
        try {
            await new Promise((resolve, reject) => {
                sock.once('error', reject);
                sock.bind(discoveryPort, () => {
                    try {
                        sock.setBroadcast(true);
                    } catch {
                        /* some platforms */
                    }
                    sock.off('error', reject);
                    resolve();
                });
            });
        } catch (e) {
            console.warn('[LAN] discovery bind failed:', e.message);
            await stopHost();
            return null;
        }

        sendAnnounce(sock);
        announceTimer = setInterval(() => sendAnnounce(sock), ANNOUNCE_MS);

        console.log(`[LAN] Hosting PeerServer ${host}:${port}${room.path} as "${name}" (${peerId})`);
        return getHostInfo();
    }

    /**
     * Tear down the current host.
     *
     * Every piece of shared state is detached SYNCHRONOUSLY up front, and the
     * awaits below only ever touch the local references. That ordering is not
     * cosmetic: closing the PeerServer waits for its existing connections —
     * the host's own Peer WebSocket among them — so this function can stay
     * suspended for as long as that takes. startHost() begins with
     * `await stopHost()`, so a player who cancels a room and immediately
     * hosts a new one used to have the new socket, server and room record
     * assigned while an older stopHost() was still parked on those awaits;
     * when it finally resumed it nulled the FRESH ones. The result was a host
     * that looked open locally but announced nothing (announcePayload needs
     * `room`), while its orphaned-yet-still-bound discovery socket also ate
     * the replies that other machines' rooms sent back — so that player could
     * neither be seen nor see anyone. Detaching first makes overlapping calls
     * harmless: a second stop finds nothing to do, and a later start builds
     * state no earlier stop still has a handle on.
     */
    async function stopHost() {
        const timer = announceTimer;
        const sock = advertiseSock;
        const server = httpServer;
        announceTimer = null;
        advertiseSock = null;
        httpServer = null;
        room = null;

        if (timer) clearInterval(timer);
        if (sock) {
            await new Promise((resolve) => {
                try {
                    sock.close(() => resolve());
                } catch {
                    resolve();
                }
            });
        }
        if (server) {
            // close() alone only stops NEW connections and then waits for the
            // live ones; the host's own Peer socket is still attached at this
            // point, so without this the port stays bound until it goes away
            // on its own and the next host has to pick a different one.
            try {
                server.closeAllConnections?.();
            } catch { /* older Node: fall through to the plain close below */ }
            await new Promise((resolve) => {
                try {
                    server.close(() => resolve());
                } catch {
                    resolve();
                }
            });
        }
    }

    function updateHost(patch = {}) {
        if (!enabled || !room) return null;
        if (patch.name != null) room.name = String(patch.name).trim() || room.name;
        if (patch.peerId != null) room.peerId = String(patch.peerId).trim() || room.peerId;
        if (patch.maxPlayers !== undefined) {
            room.maxPlayers = patch.maxPlayers == null ? null : Number(patch.maxPlayers);
        }
        if (patch.data && typeof patch.data === 'object') {
            room.data = { ...room.data, ...patch.data };
        }
        if (advertiseSock) sendAnnounce(advertiseSock);
        return getHostInfo();
    }

    /**
     * Listen for LAN announces (and poke a query broadcast + localhost).
     * Does not require hosting.
     */
    async function listRooms(options = {}) {
        if (!enabled) return [];
        const timeoutMs = Number(options.timeoutMs) || DEFAULT_LIST_TIMEOUT_MS;
        const rooms = new Map();

        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const onMsg = (msg, rinfo) => {
            const parsed = decodeMsg(msg);
            if (!parsed || parsed.t !== 'announce' || parsed.appId !== appId) return;
            if (!parsed.host || !parsed.port || !parsed.peerId) return;
            // Same-PC discovery replies come from 127.0.0.1 — PeerJS should dial
            // loopback, not our own LAN address (often fails between two local apps).
            const fromLoopback = rinfo.address === '127.0.0.1' || rinfo.address === '::1';
            const host = fromLoopback ? '127.0.0.1' : String(parsed.host);
            const key = `${host}:${parsed.port}:${parsed.peerId}`;
            rooms.set(key, {
                name: String(parsed.name || parsed.peerId),
                peerId: String(parsed.peerId),
                host,
                port: Number(parsed.port),
                path: String(parsed.path || DEFAULT_PEER_PATH),
                maxPlayers: parsed.maxPlayers == null ? null : Number(parsed.maxPlayers),
                data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
            });
        };

        try {
            await new Promise((resolve, reject) => {
                sock.once('error', reject);
                sock.bind(() => {
                    try {
                        sock.setBroadcast(true);
                    } catch {
                        /* ignore */
                    }
                    sock.off('error', reject);
                    resolve();
                });
            });
        } catch (e) {
            console.warn('[LAN] listRooms bind failed:', e.message);
            return [];
        }
        sock.on('message', onMsg);

        const query = encodeMsg({ magic: MAGIC, v: PROTOCOL, t: 'query', appId });
        const targets = new Set(['127.0.0.1', ...broadcastAddresses()]);
        for (const addr of targets) {
            try {
                sock.send(query, discoveryPort, addr);
            } catch {
                /* ignore */
            }
        }

        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        await new Promise((resolve) => {
            try {
                sock.close(() => resolve());
            } catch {
                resolve();
            }
        });

        // Same announce can arrive via localhost and LAN — prefer loopback for PeerJS.
        const byPeer = new Map();
        for (const r of rooms.values()) {
            const prev = byPeer.get(r.peerId);
            if (!prev || r.host === '127.0.0.1') byPeer.set(r.peerId, r);
        }
        return [...byPeer.values()];
    }

    return {
        isAvailable,
        startHost,
        stopHost,
        updateHost,
        listRooms,
        getHostInfo,
    };
}

module.exports = { createLan, DEFAULT_PEER_PORT, DEFAULT_PEER_PATH, DEFAULT_DISCOVERY_PORT };
