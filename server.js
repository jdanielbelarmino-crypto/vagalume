'use strict';
/* Servidor do Vagalume (Node.js puro, sem dependências).
   Serve o jogo e roda as salas online por WebSocket, com chat.
   Uso: node server.js   (porta 3000, ou PORT=8080 node server.js) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = 5;          // igual ao NET.max do jogo
const MAX_CHAT_LEN = 120;
const CHAT_BURST = 5;           // no máximo 5 mensagens...
const CHAT_WINDOW = 5000;       // ...a cada 5 s por jogador
const MAX_FRAME = 4096;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const rooms = new Map(); // código -> Map(id -> { sock, pres, chatTimes })
let nextId = 1;

/* ---------- HTTP: o jogo ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/vg-health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, game: 'vagalume', rooms: rooms.size }));
  }
  let rel;
  try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('400'); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('403'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- WebSocket mínimo (RFC 6455): texto, ping/pong, close ---------- */
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
const sendText = (sock, obj) => { if (sock.writable && !sock.destroyed) sock.write(frame(1, Buffer.from(JSON.stringify(obj)))); };
const others = (room, id, obj) => {
  const buf = frame(1, Buffer.from(JSON.stringify(obj)));
  for (const [k, p] of room) if (k !== id && p.sock.writable && !p.sock.destroyed) p.sock.write(buf);
};

// devolve mensagens completas via callbacks; fecha em protocolo inválido
function attachParser(sock, onText, onClose) {
  let buf = Buffer.alloc(0), frag = [], fragLen = 0, closed = false;
  const close = (code) => {
    if (closed) return; closed = true;
    try { const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000); sock.write(frame(8, p)); } catch (e) {}
    sock.end(); onClose();
  };
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2 && !closed) {
      const fin = !!(buf[0] & 0x80), op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const b = buf.readBigUInt64BE(2); if (b > BigInt(MAX_FRAME)) return close(1009); len = Number(b); off = 10; }
      if (!masked || len > MAX_FRAME) return close(1002);       // cliente sempre mascara
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return close(1000);
      if (op === 9) { sock.write(frame(10, data)); continue; }
      if (op === 10) { sock.isAlive = true; continue; }
      if (op === 1 || op === 0) {
        frag.push(data); fragLen += len;
        if (fragLen > MAX_FRAME) return close(1009);
        if (fin) { const txt = Buffer.concat(frag).toString('utf8'); frag = []; fragLen = 0; onText(txt); }
      }
    }
  });
  sock.on('close', () => { if (!closed) { closed = true; onClose(); } });
  sock.on('error', () => {});
  return close;
}

const cleanText = s => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_LEN);
const isPres = d => d && typeof d === 'object' && !Array.isArray(d) && JSON.stringify(d).length < 1500;

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return sock.destroy(); }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  sock.isAlive = true;

  const code = (url.searchParams.get('room') || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
  let room = null, id = null, me = null;
  const leave = () => {
    if (!room || !id) return;
    room.delete(id);
    if (room.size === 0) rooms.delete(code); else others(room, id, { t: 'l', id });
    room = null;
  };
  const close = attachParser(sock, txt => {
    if (!room) return;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'p' && isPres(m.d)) {
      me.pres = m.d;
      others(room, id, { t: 'p', id, d: m.d });
    } else if (m.t === 'c') {
      const text = cleanText(m.x);
      if (!text) return;
      const now = Date.now();
      me.chatTimes = me.chatTimes.filter(t => now - t < CHAT_WINDOW);
      if (me.chatTimes.length >= CHAT_BURST) return sendText(sock, { t: 'slow' });
      me.chatTimes.push(now);
      others(room, id, { t: 'c', id, x: text });
    }
  }, leave);

  if (code.length < 3) { sendText(sock, { t: 'err', e: 'room' }); return close(1008); }
  room = rooms.get(code);
  if (!room) { room = new Map(); rooms.set(code, room); }
  if (room.size >= MAX_PLAYERS) { room = null; sendText(sock, { t: 'full' }); return close(1008); }
  id = 'n' + (nextId++).toString(36);
  me = { sock, pres: {}, chatTimes: [] };
  const peers = {};
  for (const [k, p] of room) peers[k] = p.pres;
  room.set(id, me);
  sendText(sock, { t: 'hello', id, peers });
  others(room, id, { t: 'j', id, d: me.pres });
});

// derruba conexões mortas (celular que sumiu, etc.)
setInterval(() => {
  for (const room of rooms.values()) for (const p of room.values()) {
    if (!p.sock.isAlive) { p.sock.destroy(); continue; }
    p.sock.isAlive = false;
    try { p.sock.write(frame(9, Buffer.alloc(0))); } catch (e) {}
  }
}, 15000).unref();

server.listen(PORT, '0.0.0.0', () => console.log('Vagalume rodando em http://localhost:' + PORT));
