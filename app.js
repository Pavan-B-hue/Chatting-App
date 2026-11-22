(() => {
'use strict';

/* ================= helpers ================= */
const $ = (s) => document.querySelector(s);
const enc = new TextEncoder();
const dec = new TextDecoder();
const SALT = enc.encode('reels-lite/v1');
const CHAT_ITER = 310000;
const REELS_ITER = 150000;
const REELS_URL = 'https://www.instagram.com/reels/';
const MAX_MEDIA = 9 * 1024 * 1024;
const IMG_OK = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VID_OK = ['video/mp4', 'video/webm', 'video/quicktime'];

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
const b64 = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
};
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const uid = () => hex(crypto.getRandomValues(new Uint8Array(12)));

let cfg = null; // saved settings: names, client id, reels passcode check, room id
const S = {
  key: null, room: null, ws: null, outbox: [], ids: new Set(), urls: [],
  pickingFile: false, fails: 0, blockedUntil: 0, partner: false,
};

function loadCfg() {
  try { cfg = JSON.parse(LS.get('rl_cfg') || 'null'); } catch (_) { cfg = null; }
}

/* ================= crypto ================= */
async function deriveChat(pass) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: CHAT_ITER }, base, 512);
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, room: hex(bits.slice(32)) };
}
async function hashReels(pass, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: REELS_ITER }, base, 256);
  return b64(bits);
}
// plaintext layout: 4 bytes header length, JSON header, raw media bytes
async function seal(header, bytes) {
  const h = enc.encode(JSON.stringify(header));
  const body = new Uint8Array(4 + h.length + (bytes ? bytes.length : 0));
  new DataView(body.buffer).setUint32(0, h.length);
  body.set(h, 4);
  if (bytes) body.set(bytes, 4 + h.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.key, body);
  return { iv: b64(iv), ct: b64(ct) };
}
async function open(iv, ct) {
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, S.key, unb64(ct)));
  const hl = new DataView(pt.buffer, pt.byteOffset).getUint32(0);
  const header = JSON.parse(dec.decode(pt.subarray(4, 4 + hl)));
  header.bytes = pt.subarray(4 + hl);
  return header;
}

/* ================= local encrypted history (IndexedDB) ================= */
let dbp = null;
const db = () => dbp || (dbp = new Promise((res, rej) => {
  const r = indexedDB.open('rl', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('m', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function putItem(item) {
  try {
    const d = await db();
    await new Promise((res) => {
      const t = d.transaction('m', 'readwrite');
      t.objectStore('m').put({ id: item.id, ts: item.ts, iv: item.iv, ct: item.ct });
      t.oncomplete = res; t.onerror = res; t.onabort = res;
    });
  } catch (_) {}
}
async function allItems() {
  try {
    const d = await db();
    const items = await new Promise((res) => {
      const r = d.transaction('m').objectStore('m').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
    return items.sort((a, b) => a.ts - b.ts);
  } catch (_) { return []; }
}

/* ================= views, lock ================= */
function show(name) {
  for (const v of ['lock', 'setup', 'chat', 'draw']) $('#' + v).classList.toggle('hidden', v !== name);
}
let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function teardown() {
  S.wantWs = false;
  if (S.ws) { try { S.ws.close(); } catch (_) {} S.ws = null; }
  S.outbox = [];
  S.ids = new Set();
  S.key = null;
  S.room = null;
  S.partner = false;
  for (const u of S.urls) URL.revokeObjectURL(u);
  S.urls = [];
  $('#msgs').textContent = '';
  $('#msg').value = '';
  $('#gifGrid').textContent = '';
  $('#gifQ').value = '';
  closePanel();
  draw.reset();
  $('#toast').classList.add('hidden');
}

function lock() {
  if (S.pickingFile || !S.key) return;
  teardown();
  $('#pw').value = '';
  $('#lockErr').textContent = '';
  show('lock');
}
document.addEventListener('visibilitychange', () => { if (document.hidden) lock(); });
window.addEventListener('pagehide', lock);
window.addEventListener('blur', lock);
$('#btnLock').addEventListener('click', () => { S.pickingFile = false; lock(); });

/* ================= setup ================= */
$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#setupErr');
  const name = $('#sName').value.trim() || 'Me';
  const their = $('#sTheir').value.trim() || 'Chat';
  const reels = $('#sReels').value;
  const chat = $('#sChat').value;
  if (reels.length < 4 || chat.length < 4) { err.textContent = 'Use at least 4 characters for each passcode.'; return; }
  if (reels === chat) { err.textContent = 'The two passcodes must be different.'; return; }
  if (chat !== $('#sChat2').value) { err.textContent = 'The chat passcode does not match the repeat.'; return; }
  err.textContent = 'Saving...';
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const reelsHash = await hashReels(reels, salt);
  const { room } = await deriveChat(chat);
  const old = cfg && cfg.cid;
  cfg = { name, their, cid: old || uid(), reels: { salt, hash: reelsHash }, room };
  LS.set('rl_cfg', JSON.stringify(cfg));
  for (const id of ['sName', 'sTheir', 'sReels', 'sChat', 'sChat2']) $('#' + id).value = '';
  err.textContent = '';
  show('lock');
});

/* ================= unlock ================= */
$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#lockErr');
  const pass = $('#pw').value;
  if (!pass) return;
  const now = Date.now();
  if (now < S.blockedUntil) { err.textContent = 'Try again in a few seconds.'; return; }
  const chat = await deriveChat(pass);
  if (chat.room === cfg.room) {
    S.fails = 0;
    S.key = chat.key;
    S.room = chat.room;
    $('#pw').value = '';
    await openChat();
    return;
  }
  const h = await hashReels(pass, cfg.reels.salt);
  if (h === cfg.reels.hash) {
    S.fails = 0;
    $('#pw').value = '';
    location.replace(REELS_URL);
    return;
  }
  S.fails += 1;
  if (S.fails >= 3) { S.blockedUntil = Date.now() + 10000; S.fails = 0; }
  err.textContent = 'Incorrect passcode';
  const f = $('#lockForm');
  f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
  $('#pw').value = '';
});
$('#pw').addEventListener('input', () => { $('#lockErr').textContent = ''; });

/* ================= chat ================= */
async function openChat() {
  $('#theirName').textContent = cfg.their || 'Chat';
  setStatus();
  show('chat');
  const items = await allItems();
  for (const it of items) {
    if (!S.key) return; // locked while loading
    await showItem(it);
  }
  S.wantWs = true;
  connect();
}

function setStatus(text) {
  $('#status').textContent = text || (S.partner ? 'online' : (S.ws && S.ws.readyState === 1 ? 'offline' : 'connecting'));
}

function connect() {
  if (!S.key || !S.wantWs) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host);
  S.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', room: S.room, since: Number(LS.get('rl_since') || 0) }));
  };
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (S.ws !== ws || !S.key) return;
    if (m.t === 'backlog') {
      const since = Number(LS.get('rl_since') || 0);
      if (m.seq < since) { LS.set('rl_since', '0'); ws.close(); return; } // server was reset
      for (const it of m.items) await handleItem(it);
      for (const o of S.outbox.splice(0)) ws.send(o);
      setStatus();
    } else if (m.t === 'msg') {
      await handleItem(m.item);
    } else if (m.t === 'presence') {
      S.partner = m.n >= 2;
      setStatus();
    } else if (m.t === 'live') {
      try { draw.remote(await open(m.iv, m.ct)); } catch (_) {}
    } else if (m.t === 'full') {
      toast('This chat is already open on two devices.');
    }
  };
  ws.onclose = () => {
    if (S.ws === ws) {
      S.ws = null; S.partner = false; setStatus('connecting');
      if (S.key && S.wantWs) setTimeout(connect, 2000);
    }
  };
  ws.onerror = () => {};
}

async function handleItem(item) {
  if (item.seq) LS.set('rl_since', String(item.seq));
  if (S.ids.has(item.id)) return;
  await putItem(item);
  await showItem(item);
}

async function showItem(item) {
  if (S.ids.has(item.id)) return;
  let p;
  try { p = await open(item.iv, item.ct); } catch (_) { return; }
  if (!S.key) return;
  S.ids.add(item.id);
  const box = $('#msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.appendChild(buildBubble(item, p));
  if (nearBottom || p.from === cfg.cid) box.scrollTop = box.scrollHeight;
}

function blobUrl(bytes, mime) {
  const u = URL.createObjectURL(new Blob([bytes], { type: mime }));
  S.urls.push(u);
  return u;
}

function buildBubble(item, p) {
  const mine = p.from === cfg.cid;
  const row = document.createElement('div');
  row.className = 'row ' + (mine ? 'me' : 'them');
  const b = document.createElement('div');
  b.className = 'bubble';
  if (p.k === 'text') {
    b.textContent = String(p.text || '');
  } else if (p.k === 'sticker' && STICKERS[p.id]) {
    b.classList.add('sticker');
    const img = document.createElement('img');
    img.alt = 'Sticker';
    img.src = stickerSrc(p.id);
    b.appendChild(img);
  } else if (p.k === 'gif' && /^https:\/\/media\d*\.giphy\.com\//.test(String(p.url || ''))) {
    b.classList.add('sticker');
    const img = document.createElement('img');
    img.alt = 'Sticker';
    img.src = p.url;
    b.appendChild(img);
  } else if (p.k === 'img' && IMG_OK.includes(p.mime)) {
    b.classList.add('media');
    const img = document.createElement('img');
    img.alt = 'Photo';
    img.src = blobUrl(p.bytes, p.mime);
    b.appendChild(img);
  } else if (p.k === 'video' && VID_OK.includes(p.mime)) {
    b.classList.add('media');
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.preload = 'metadata';
    v.src = blobUrl(p.bytes, p.mime);
    b.appendChild(v);
  } else {
    b.textContent = 'Unsupported message';
  }
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.append(b, t);
  return row;
}

async function sendMsg(header, bytes) {
  if (!S.key) return;
  const sealed = await seal({ ...header, from: cfg.cid, name: cfg.name }, bytes);
  const frame = JSON.stringify({ t: 'msg', id: uid(), iv: sealed.iv, ct: sealed.ct });
  if (S.ws && S.ws.readyState === 1) S.ws.send(frame);
  else { S.outbox.push(frame); toast('Not connected yet, will send when connected.'); }
}

function sendText() {
  const input = $('#msg');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendMsg({ k: 'text', text });
}
$('#btnSend').addEventListener('click', sendText);
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });

/* ---------- photos and videos ---------- */
const fileInput = $('#file');
let pickTimer = null;
$('#btnAttach').addEventListener('click', () => {
  S.pickingFile = true;
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => { S.pickingFile = false; }, 90000);
  fileInput.value = '';
  fileInput.click();
});
const donePicking = () => { clearTimeout(pickTimer); setTimeout(() => { S.pickingFile = false; }, 400); };
fileInput.addEventListener('cancel', donePicking);
fileInput.addEventListener('change', async () => {
  const f = fileInput.files && fileInput.files[0];
  donePicking();
  if (!f) return;
  try {
    if (f.type.startsWith('image/')) {
      const { mime, bytes } = await prepImage(f);
      if (bytes.length > MAX_MEDIA) return toast('That photo is too large.');
      await sendMsg({ k: 'img', mime }, bytes);
    } else if (VID_OK.includes(f.type)) {
      if (f.size > MAX_MEDIA) return toast('Video too large. Maximum is 9 MB.');
      await sendMsg({ k: 'video', mime: f.type }, new Uint8Array(await f.arrayBuffer()));
    } else {
      toast('Only photos and videos can be sent.');
    }
  } catch (_) { toast('Could not send that file.'); }
});
async function prepImage(file) {
  if (file.type === 'image/gif' && file.size < 4e6) return { mime: 'image/gif', bytes: new Uint8Array(await file.arrayBuffer()) };
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  return { mime: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/* ---------- panels: emojis, stickers, online stickers ---------- */
const STICKERS = {
  heart: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 21s-7-4.4-9.5-9A5.5 5.5 0 0 1 12 6.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.6-9.5 9-9.5 9z" fill="#C2305A"/></svg>',
  star: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,2 15,9 22,9.5 16.5,14 18.5,21 12,17 5.5,21 7.5,14 2,9.5 9,9" fill="#F5A623"/></svg>',
  smile: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#F5C542"/><circle cx="8.5" cy="10" r="1.3" fill="#3B1F2B"/><circle cx="15.5" cy="10" r="1.3" fill="#3B1F2B"/><path d="M7.5 14.5Q12 19 16.5 14.5" fill="none" stroke="#3B1F2B" stroke-width="1.6" stroke-linecap="round"/></svg>',
  moon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" fill="#6B5B95"/></svg>',
  cloud: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1 .6-9 6 6 0 0 1 11.3 1.5A3.8 3.8 0 0 1 18 18z" fill="#6FB1DE"/></svg>',
  flower: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="6" r="4" fill="#F29BB0"/><circle cx="18" cy="10" r="4" fill="#F29BB0"/><circle cx="16" cy="17" r="4" fill="#F29BB0"/><circle cx="8" cy="17" r="4" fill="#F29BB0"/><circle cx="6" cy="10" r="4" fill="#F29BB0"/><circle cx="12" cy="12" r="3" fill="#F5C542"/></svg>',
  sun: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="#F5A623"/><g stroke="#F5A623" stroke-width="2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="5" y1="5" x2="6.4" y2="6.4"/><line x1="17.6" y1="17.6" x2="19" y2="19"/><line x1="5" y1="19" x2="6.4" y2="17.6"/><line x1="17.6" y1="6.4" x2="19" y2="5"/></g></svg>',
  sparkle: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" fill="#9B6BD6"/></svg>',
};
const stickerSrc = (id) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(STICKERS[id]);

const EMOJI_GROUPS = [
  ['\u{1F600}', [[0x1F600, 0x1F64F], [0x1F910, 0x1F92F]]],
  ['❤️', [[0x1F493, 0x1F49F], [0x1F90D, 0x1F90E], [0x1F9E1, 0x1F9E1], [0x1F48B, 0x1F48D], [0x1F339, 0x1F33A], [0x1F490, 0x1F490]]],
  ['\u{1F44B}', [[0x1F44A, 0x1F450], [0x1F64C, 0x1F64C], [0x1F64F, 0x1F64F], [0x1F90C, 0x1F90F], [0x1F918, 0x1F91F], [0x1F4AA, 0x1F4AA]]],
  ['\u{1F436}', [[0x1F400, 0x1F43E], [0x1F980, 0x1F9AE]]],
  ['\u{1F355}', [[0x1F345, 0x1F37F], [0x1F950, 0x1F96B]]],
  ['⚽', [[0x1F380, 0x1F3C4], [0x1F3A0, 0x1F3AF]]],
  ['\u{1F680}', [[0x1F680, 0x1F6A4], [0x1F30D, 0x1F320]]],
  ['✨', [[0x2600, 0x2604], [0x2614, 0x2615], [0x2728, 0x2728], [0x2B50, 0x2B50], [0x1F31F, 0x1F31F], [0x1F4A1, 0x1F4AF]]],
];
function buildEmoji() {
  const tabs = $('#emojiTabs');
  const grid = $('#emojiGrid');
  const fill = (idx) => {
    grid.textContent = '';
    for (const [a, z] of EMOJI_GROUPS[idx][1]) {
      for (let cp = a; cp <= z; cp++) {
        const bt = document.createElement('button');
        bt.type = 'button';
        bt.textContent = String.fromCodePoint(cp);
        bt.addEventListener('click', () => insertAtCaret(bt.textContent));
        grid.appendChild(bt);
      }
    }
    [...tabs.children].forEach((t, i) => t.classList.toggle('on', i === idx));
  };
  EMOJI_GROUPS.forEach(([icon], i) => {
    const t = document.createElement('button');
    t.type = 'button'; t.textContent = icon;
    t.addEventListener('click', () => fill(i));
    tabs.appendChild(t);
  });
  fill(0);
}
function insertAtCaret(text) {
  const el = $('#msg');
  const s = el.selectionStart == null ? el.value.length : el.selectionStart;
  const e = el.selectionEnd == null ? el.value.length : el.selectionEnd;
  el.value = el.value.slice(0, s) + text + el.value.slice(e);
  el.selectionStart = el.selectionEnd = s + text.length;
}
function buildStickers() {
  const g = $('#stickerGrid');
  for (const id of Object.keys(STICKERS)) {
    const bt = document.createElement('button');
    bt.type = 'button'; bt.setAttribute('aria-label', 'Send ' + id + ' sticker');
    const img = document.createElement('img');
    img.alt = ''; img.src = stickerSrc(id);
    bt.appendChild(img);
    bt.addEventListener('click', () => { sendMsg({ k: 'sticker', id }); closePanel(); });
    g.appendChild(bt);
  }
}
function closePanel() {
  $('#panel').classList.add('hidden');
  $('#panelEmoji').classList.add('hidden');
  $('#panelSticker').classList.add('hidden');
  $('#btnEmoji').classList.remove('on');
  $('#btnSticker').classList.remove('on');
}
function togglePanel(which) {
  const open = !$('#panel' + which).classList.contains('hidden');
  closePanel();
  if (open) return;
  $('#panel').classList.remove('hidden');
  $('#panel' + which).classList.remove('hidden');
  $('#btn' + which).classList.add('on');
  if (which === 'Sticker') $('#gifSetup').classList.toggle('hidden', !!LS.get('rl_giphy'));
}
$('#btnEmoji').addEventListener('click', () => togglePanel('Emoji'));
$('#btnSticker').addEventListener('click', () => togglePanel('Sticker'));
$('#gifKeySave').addEventListener('click', () => {
  const k = $('#gifKey').value.trim();
  if (!k) return;
  LS.set('rl_giphy', k);
  $('#gifKey').value = '';
  $('#gifSetup').classList.add('hidden');
  toast('Key saved.');
});
async function searchGifs() {
  const key = LS.get('rl_giphy');
  const q = $('#gifQ').value.trim();
  if (!key) { $('#gifSetup').classList.remove('hidden'); return; }
  if (!q) return;
  const grid = $('#gifGrid');
  grid.textContent = '';
  try {
    const r = await fetch('https://api.giphy.com/v1/stickers/search?api_key=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(q) + '&limit=18&rating=g');
    const j = await r.json();
    for (const d of j.data || []) {
      const u = d.images && d.images.fixed_height && d.images.fixed_height.url;
      if (!u || !/^https:\/\/media\d*\.giphy\.com\//.test(u)) continue;
      const bt = document.createElement('button');
      bt.type = 'button';
      const img = document.createElement('img');
      img.alt = d.title || 'Sticker'; img.src = u; img.loading = 'lazy';
      bt.appendChild(img);
      bt.addEventListener('click', () => { sendMsg({ k: 'gif', url: u }); closePanel(); });
      grid.appendChild(bt);
    }
    if (!grid.children.length) toast('No stickers found.');
  } catch (_) { toast('Could not reach the sticker service.'); }
}
$('#gifGo').addEventListener('click', searchGifs);
$('#gifQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchGifs(); } });

/* ================= drawing zone ================= */
const draw = (() => {
  const cv = $('#canvas');
  const ctx = cv.getContext('2d');
  const COLORS = [['#C2305A', 'Rose'], ['#E8761E', 'Orange'], ['#F5C542', 'Yellow'], ['#3AA76D', 'Green'], ['#3A8FD0', 'Blue'], ['#3B1F2B', 'Plum']];
  let strokes = [];
  let color = COLORS[0][0];
  let size = 12;
  let cur = null;
  let pending = [];
  let timer = null;

  const paintStroke = (s, fromIdx) => {
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineWidth = s.w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pts = s.pts;
    if (pts.length === 1 && fromIdx === 0) {
      ctx.beginPath(); ctx.arc(pts[0][0] * 900, pts[0][1] * 1200, s.w / 2, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.beginPath();
    const start = Math.max(0, fromIdx - 1);
    ctx.moveTo(pts[start][0] * 900, pts[start][1] * 1200);
    for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * 900, pts[i][1] * 1200);
    ctx.stroke();
  };
  const redraw = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 900, 1200);
    for (const s of strokes) paintStroke(s, 0);
  };
  const emit = async (obj) => {
    if (!S.key || !S.ws || S.ws.readyState !== 1) return;
    const sealed = await seal(obj);
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: 'live', iv: sealed.iv, ct: sealed.ct }));
  };
  const flush = () => {
    timer = null;
    if (!cur || !pending.length) return;
    emit({ d: 'pts', sid: cur.sid, c: cur.c, w: cur.w, pts: pending });
    pending = [];
  };
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!S.key) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = pos(e);
    cur = { sid: uid(), by: cfg.cid, c: color, w: size, pts: [p] };
    strokes.push(cur);
    paintStroke(cur, 0);
    pending = [p];
    if (!timer) timer = setTimeout(flush, 40);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    e.preventDefault();
    const p = pos(e);
    cur.pts.push(p);
    paintStroke(cur, cur.pts.length - 1);
    pending.push(p);
    if (!timer) timer = setTimeout(flush, 40);
  });
  const end = () => { if (cur) { flush(); cur = null; } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  COLORS.forEach(([c, label], i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw' + (i === 0 ? ' on' : ''); b.setAttribute('aria-label', label);
    const s = document.createElement('span'); s.style.background = c;
    b.appendChild(s);
    b.addEventListener('click', () => {
      color = c;
      document.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b));
    });
    $('#colors').appendChild(b);
  });
  document.querySelectorAll('.brush').forEach((b) => b.addEventListener('click', () => {
    size = Number(b.dataset.size);
    document.querySelectorAll('.brush').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#dUndo').addEventListener('click', () => {
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].by === cfg.cid) { const sid = strokes[i].sid; strokes.splice(i, 1); redraw(); emit({ d: 'undo', sid }); return; }
    }
  });
  $('#dClear').addEventListener('click', () => { strokes = []; redraw(); emit({ d: 'clear' }); });
  $('#dSend').addEventListener('click', async () => {
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    await sendMsg({ k: 'img', mime: 'image/png' }, new Uint8Array(await blob.arrayBuffer()));
    toast('Drawing sent to chat.');
  });
  $('#btnDraw').addEventListener('click', () => { closePanel(); show('draw'); redraw(); });
  $('#dBack').addEventListener('click', () => show('chat'));

  return {
    reset() { strokes = []; cur = null; pending = []; clearTimeout(timer); timer = null; redraw(); },
    remote(m) {
      if (m.d === 'clear') { strokes = []; redraw(); return; }
      if (m.d === 'undo') { strokes = strokes.filter((s) => s.sid !== m.sid); redraw(); return; }
      if (m.d === 'pts' && Array.isArray(m.pts)) {
        let s = strokes.find((x) => x.sid === m.sid);
        if (!s) { s = { sid: m.sid, by: 'peer', c: String(m.c), w: Number(m.w) || 12, pts: [] }; strokes.push(s); }
        const from = s.pts.length;
        for (const p of m.pts) s.pts.push([Number(p[0]), Number(p[1])]);
        if (!$('#draw').classList.contains('hidden')) paintStroke(s, from);
      }
    },
  };
})();

/* ================= start ================= */
buildEmoji();
buildStickers();
loadCfg();
draw.reset();
show(cfg && cfg.room ? 'lock' : 'setup');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
