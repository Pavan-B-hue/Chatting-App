
'use strict';

// Reels Lite relay server.
// Serves the web application and forwards encrypted messages
// between two people in a room.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Application files are stored in the repository root.
const PUBLIC_DIR = __dirname;

// Store backlog data inside the repository directory.
const DATA_FILE =
    process.env.DATA_FILE ||
    path.join(__dirname, 'data', 'backlog.json');

const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_BACKLOG_BYTES = 60 * 1024 * 1024;
const MAX_ROOMS = 50;

const ROOM_RE = /^[a-f0-9]{64}$/;

// MIME types
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// Room storage
const rooms = new Map();

// Load saved messages
function loadBacklog() {
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

        for (const [roomId, r] of Object.entries(raw)) {
            rooms.set(roomId, {
                seq: r.seq,
                items: r.items,
                bytes: r.bytes,
                clients: new Set()
            });
        }

        console.log('Backlog loaded successfully');
    } catch (err) {
        console.log('No existing backlog found. Starting fresh.');
    }
}

// Save messages
let saveTimer = null;

function saveSoon() {
    if (saveTimer) return;

    saveTimer = setTimeout(() => {
        saveTimer = null;

        try {
            fs.mkdirSync(path.dirname(DATA_FILE), {
                recursive: true
            });

            const out = {};

            for (const [roomId, r] of rooms) {
                out[roomId] = {
                    seq: r.seq,
                    items: r.items,
                    bytes: r.bytes
                };
            }

            fs.writeFileSync(
                DATA_FILE + '.tmp',
                JSON.stringify(out)
            );

            fs.renameSync(
                DATA_FILE + '.tmp',
                DATA_FILE
            );
        } catch (err) {
            console.error('Save failed:', err.message);
        }

    }, 1500);
}

// Get or create room
function getRoom(roomId) {
    let r = rooms.get(roomId);

    if (!r) {
        if (rooms.size >= MAX_ROOMS) return null;

        r = {
            seq: 0,
            items: [],
            bytes: 0,
            clients: new Set()
        };

        rooms.set(roomId, r);
    }

    return r;
}

// HTTP SERVER
const server = http.createServer((req, res) => {
    let urlPath;

    try {
        const parsedUrl = new URL(
            req.url || '/',
            'http://localhost'
        );

        urlPath = decodeURIComponent(parsedUrl.pathname);

    } catch (err) {
        res.writeHead(400);
        return res.end('Bad Request');
    }

    console.log(`${req.method} ${urlPath}`);

    // Health check
    if (urlPath === '/healthz') {
        res.writeHead(200, {
            'Content-Type': 'text/plain'
        });

        return res.end('ok');
    }

    // Deployment diagnostic
    if (urlPath === '/debug-check') {
        res.writeHead(200, {
            'Content-Type': 'text/plain'
        });

        return res.end('REELS LITE UPDATED SERVER');
    }

    // Root route
    if (urlPath === '/') {
        urlPath = '/index.html';
    }

    // Static file handling
    const filePath = path.resolve(
        PUBLIC_DIR,
        '.' + urlPath
    );

    // Prevent directory traversal
    const relativePath = path.relative(
        PUBLIC_DIR,
        filePath
    );

    if (
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath)
    ) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, buf) => {

        if (err) {
            console.log(
                'File not found:',
                filePath
            );

            res.writeHead(404, {
                'Content-Type': 'text/plain'
            });

            return res.end('Not found');
        }

        res.writeHead(200, {
            'Content-Type':
                MIME[path.extname(filePath)] ||
                'application/octet-stream',

            'Cache-Control': 'no-cache',

            'X-Content-Type-Options': 'nosniff',

            'Referrer-Policy': 'no-referrer'
        });

        res.end(buf);
    });
});

// WEBSOCKET SERVER
const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD
});

// Broadcast messages
function broadcast(room, obj, except) {
    const s = JSON.stringify(obj);

    for (const c of room.clients) {
        if (
            c !== except &&
            c.readyState === 1
        ) {
            c.send(s);
        }
    }
}

// Presence updates
function sendPresence(room) {
    broadcast(room, {
        t: 'presence',
        n: room.clients.size
    });
}

// WebSocket connections
wss.on('connection', (ws) => {

    let room = null;

    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {

        if (isBinary) return;

        let m;

        try {
            m = JSON.parse(data.toString());
        } catch (err) {
            return;
        }

        if (!m || typeof m.t !== 'string') return;

        // Join room
        if (m.t === 'hello') {
            if (
                room ||
                typeof m.room !== 'string' ||
                !ROOM_RE.test(m.room)
            ) {
                ws.close();
                return;
            }

            room = getRoom(m.room);

            if (!room) {
                ws.close();
                return;
            }

            if (room.clients.size >= 2) {
                ws.send(JSON.stringify({
                    t: 'full'
                }));

                ws.close();
                return;
            }

            room.clients.add(ws);

            const since = Number.isInteger(m.since)
                ? m.since
                : 0;

            const missed = room.items.filter(
                (i) => i.seq > since
            );

            ws.send(JSON.stringify({
                t: 'backlog',
                items: missed,
                seq: room.seq
            }));

            sendPresence(room);

            return;
        }

        if (!room) return;

        // Regular encrypted messages
        if (m.t === 'msg') {

            if (
                typeof m.id !== 'string' ||
                typeof m.iv !== 'string' ||
                typeof m.ct !== 'string'
            ) {
                return;
            }

            if (
                m.id.length > 64 ||
                room.items.some((i) => i.id === m.id)
            ) {
                return;
            }

            const size = m.ct.length + m.iv.length;

            const item = {
                seq: ++room.seq,
                id: m.id,
                ts: Date.now(),
                iv: m.iv,
                ct: m.ct,
                size
            };

            room.items.push(item);

            room.bytes += size;

            while (
                room.bytes > MAX_BACKLOG_BYTES &&
                room.items.length > 1
            ) {
                room.bytes -= room.items.shift().size;
            }

            saveSoon();

            broadcast(room, {
                t: 'msg',
                item
            });

            return;
        }

        // Live encrypted drawing events
        if (m.t === 'live') {

            if (
                typeof m.iv !== 'string' ||
                typeof m.ct !== 'string' ||
                m.ct.length > 20000
            ) {
                return;
            }

            broadcast(room, {
                t: 'live',
                iv: m.iv,
                ct: m.ct
            }, ws);
        }
    });

    ws.on('close', () => {
        if (room) {
            room.clients.delete(ws);
            sendPresence(room);
        }
    });

    ws.on('error', () => {});
});

// WebSocket heartbeat
setInterval(() => {

    for (const ws of wss.clients) {

        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }

        ws.isAlive = false;
        ws.ping();
    }

}, 30000);

// Start server
loadBacklog();

server.listen(PORT, '0.0.0.0', () => {
    console.log('================================');
    console.log('REELS LITE SERVER STARTED');
    console.log('Port:', PORT);
    console.log('Public directory:', PUBLIC_DIR);
    console.log('Health check: /healthz');
    console.log('Debug check: /debug-check');
    console.log('================================');
});
