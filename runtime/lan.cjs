/**
 * LAN discovery + local PeerJS signaling for offline / LAN-party play.
 *
 * Opt-in via steamElectronBuild.lan === true. When disabled, createLan()
 * returns a stub that never opens ports.
 *
 * Discovery: UDP broadcast (CS-style query/announce), filtered by appId.
 * Signaling: PeerServer on the host; games use PeerJS client against host/port/path.
 */

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const express = require('express');

const MAGIC = 'seb-lan';
const PROTOCOL = 1;
const DEFAULT_PEER_PORT = 9000;
const DEFAULT_PEER_PATH = '/peerjs';
const DEFAULT_DISCOVERY_PORT = 41234;
const ANNOUNCE_MS = 1000;
const DEFAULT_LIST_TIMEOUT_MS = 1500;

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
    // Subnet broadcasts when we can derive them; always include limited broadcast.
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
            sock.send(buf, port, targetAddr);
            return;
        }
        for (const addr of broadcastAddresses()) {
            try {
                sock.send(buf, port, addr);
            } catch {
                /* ignore per-iface send failures */
            }
        }
    }

    async function startHost(options = {}) {
        if (!enabled) return null;
        await stopHost();

        const name = String(options.name ?? '').trim() || 'Host';
        const peerId = String(options.peerId ?? name).trim() || name;
        const port = Number(options.port) || DEFAULT_PEER_PORT;
        const path = String(options.path || DEFAULT_PEER_PATH);
        const maxPlayers = options.maxPlayers == null ? null : Number(options.maxPlayers);
        const data = options.data && typeof options.data === 'object' ? { ...options.data } : {};
        const host = primaryLanIPv4();

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

        await new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(port, '0.0.0.0', () => {
                httpServer.off('error', reject);
                resolve();
            });
        });

        room = { name, peerId, host, port, path: peerMount || '/peerjs', maxPlayers, data };

        advertiseSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        advertiseSock.on('message', (msg, rinfo) => {
            const parsed = decodeMsg(msg);
            if (!parsed || parsed.appId !== appId) return;
            if (parsed.t === 'query') sendAnnounce(advertiseSock, rinfo.address, rinfo.port);
        });
        await new Promise((resolve, reject) => {
            advertiseSock.once('error', reject);
            advertiseSock.bind(discoveryPort, () => {
                try {
                    advertiseSock.setBroadcast(true);
                } catch {
                    /* some platforms */
                }
                advertiseSock.off('error', reject);
                resolve();
            });
        });

        sendAnnounce(advertiseSock);
        announceTimer = setInterval(() => sendAnnounce(advertiseSock), ANNOUNCE_MS);

        console.log(`[LAN] Hosting PeerServer ${host}:${port}${room.path} as "${name}" (${peerId})`);
        return getHostInfo();
    }

    async function stopHost() {
        if (announceTimer) {
            clearInterval(announceTimer);
            announceTimer = null;
        }
        if (advertiseSock) {
            await new Promise((resolve) => {
                try {
                    advertiseSock.close(() => resolve());
                } catch {
                    resolve();
                }
            });
            advertiseSock = null;
        }
        if (httpServer) {
            await new Promise((resolve) => {
                httpServer.close(() => resolve());
            });
            httpServer = null;
        }
        room = null;
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
     * Listen for LAN announces (and poke a query broadcast). Does not require hosting.
     */
    async function listRooms(options = {}) {
        if (!enabled) return [];
        const timeoutMs = Number(options.timeoutMs) || DEFAULT_LIST_TIMEOUT_MS;
        const rooms = new Map();

        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const onMsg = (msg) => {
            const parsed = decodeMsg(msg);
            if (!parsed || parsed.t !== 'announce' || parsed.appId !== appId) return;
            if (!parsed.host || !parsed.port || !parsed.peerId) return;
            const key = `${parsed.host}:${parsed.port}:${parsed.peerId}`;
            rooms.set(key, {
                name: String(parsed.name || parsed.peerId),
                peerId: String(parsed.peerId),
                host: String(parsed.host),
                port: Number(parsed.port),
                path: String(parsed.path || DEFAULT_PEER_PATH),
                maxPlayers: parsed.maxPlayers == null ? null : Number(parsed.maxPlayers),
                data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
            });
        };

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
        sock.on('message', onMsg);

        const query = encodeMsg({ magic: MAGIC, v: PROTOCOL, t: 'query', appId });
        for (const addr of broadcastAddresses()) {
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

        return [...rooms.values()];
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
