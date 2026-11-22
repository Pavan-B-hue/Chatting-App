'use strict';
// Reels Lite relay server.
// It serves the web app and forwards messages between the two people in a room.
// Everything it forwards is already encrypted in the browser, so the server
// never sees passcodes, keys, text, photos or drawings.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'backlog.json');
const MAX_PAYLOAD = 16 * 1024 * 1024; // one message (media is base64 inside)
const MAX_BACKLOG_BYTES = 60 * 1024 * 1024; // per room, oldest dropped first
const MAX_ROOMS = 50;
const ROOM_RE = /^[a-f0-9]{64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// rooms: Map<roomId, { seq, items: [{seq, id, ts, iv, ct, size}], bytes, clients:Set<ws> }>
const rooms = new Map();

function loadBacklog() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [roomId, r] of Object.entries(raw)) {
      rooms.set(roomId, { seq: r.seq, items: r.items, bytes: r.bytes, clients: new Set() });
    }
  } catch (_) { /* first run */ }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const out = {};
      for (const [roomId, r] of rooms) out[roomId] = { seq: r.seq, items: r.items, bytes: r.bytes };
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('save failed', e.message); }
  }, 1500);
}

function getRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { seq: 0, items: [], bytes: 0, clients: new Set() };
    rooms.set(roomId, r);
  }
  return r;
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(s);
}

function sendPresence(room) {
  broadcast(room, { t: 'presence', n: room.clients.size });
}

wss.on('connection', (ws) => {
  let room = null;
  let roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (room || typeof m.room !== 'string' || !ROOM_RE.test(m.room)) { ws.close(); return; }
      room = getRoom(m.room);
      if (!room) { ws.close(); return; }
      roomId = m.room;
      if (room.clients.size >= 2) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
      room.clients.add(ws);
      const since = Number.isInteger(m.since) ? m.since : 0;
      const missed = room.items.filter((i) => i.seq > since);
      ws.send(JSON.stringify({ t: 'backlog', items: missed, seq: room.seq }));
      sendPresence(room);
      return;
    }

    if (!room) return;

    if (m.t === 'msg') {
      if (typeof m.id !== 'string' || typeof m.iv !== 'string' || typeof m.ct !== 'string') return;
      if (m.id.length > 64 || room.items.some((i) => i.id === m.id)) return;
      const size = m.ct.length + m.iv.length;
      const item = { seq: ++room.seq, id: m.id, ts: Date.now(), iv: m.iv, ct: m.ct, size };
      room.items.push(item);
      room.bytes += size;
      while (room.bytes > MAX_BACKLOG_BYTES && room.items.length > 1) {
        room.bytes -= room.items.shift().size;
      }
      saveSoon();
      broadcast(room, { t: 'msg', item });
      return;
    }

    if (m.t === 'live') {
      // Ephemeral encrypted events (drawing strokes). Relayed, never stored.
      if (typeof m.iv !== 'string' || typeof m.ct !== 'string' || m.ct.length > 20000) return;
      broadcast(room, { t: 'live', iv: m.iv, ct: m.ct }, ws);
    }
  });

  ws.on('close', () => {
    if (room) { room.clients.delete(ws); sendPresence(room); }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

loadBacklog();
server.listen(PORT, () => console.log('Reels Lite server on port ' + PORT));
