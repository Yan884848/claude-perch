#!/usr/bin/env node
/**
 * Perch — start Claude Code sessions on your computer, from your phone.
 *
 * Two ways to run a session:
 *   1. App mode (default). Spawns `claude --remote-control` inside tmux. The
 *      session registers with Anthropic's relay and shows up in the Claude
 *      mobile app, where you chat with the full native UI.
 *   2. Web mode. Spawns headless `claude -p` with streaming JSON I/O and
 *      renders the conversation in this page. Useful as a fallback, or when
 *      Remote Control is unavailable on your plan.
 *
 * No dependencies — Node builtins only.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// ---------- config ----------
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.PERCH_TOKEN || '';
const MODEL = process.env.PERCH_MODEL || 'opus';
const PERMISSION_MODE = process.env.PERCH_PERMISSION_MODE || 'bypassPermissions';
const PROJECTS_DIR = path.join(os.homedir(), '.claude/projects');
const SCAN_ROOTS = (process.env.PERCH_ROOTS || path.join(os.homedir(), 'Projects'))
  .split(':').filter(Boolean);

function which(bin, fallbacks) {
  try {
    return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim() || null;
  } catch {
    for (const f of fallbacks) if (fs.existsSync(f)) return f;
    return bin;
  }
}
const CLAUDE = process.env.CLAUDE_BIN
  || which('claude', [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude']);
const TMUX = process.env.TMUX_BIN
  || which('tmux', ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']);
const CAPTURE_BIN = process.env.PERCH_CAPTURE_BIN || path.join(__dirname, 'bin/perch-capture');
const INPUT_BIN = process.env.PERCH_INPUT_BIN || path.join(__dirname, 'bin/perch-input');

// ---------- project discovery ----------
function statTime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function readHead(p, bytes = 65536) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

/** Claude stores transcripts under ~/.claude/projects/<mangled-path>/. The
 *  directory name is lossy (slashes and dashes collide), so read the real cwd
 *  out of a transcript instead of trying to decode it. */
function cwdFromProjectDir(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
  catch { return null; }
  files.sort((a, b) => statTime(path.join(dir, b)) - statTime(path.join(dir, a)));
  for (const f of files.slice(0, 3)) {
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readHead(path.join(dir, f)));
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  }
  return null;
}

function listProjects() {
  const seen = new Map();
  const add = (cwd, lastUsed) => {
    if (!cwd) return;
    try { if (!fs.statSync(cwd).isDirectory()) return; } catch { return; }
    const prev = seen.get(cwd);
    if (!prev || lastUsed > prev.lastUsed) {
      seen.set(cwd, { cwd, name: path.basename(cwd), lastUsed });
    }
  };
  // Directories Claude has been used in, most recent first.
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    add(cwdFromProjectDir(full), statTime(full));
  }
  // Plus anything under the configured roots, so fresh projects show up too.
  for (const root of SCAN_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      add(path.join(root, e.name), 0);
    }
  }
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

// ---------- app-mode sessions (tmux + Remote Control) ----------
const RC_PREFIX = 'perch-';

function tmux(args) {
  return execFileSync(TMUX, args, { encoding: 'utf8', timeout: 10000 });
}
function tmuxSafe(args) {
  try { return tmux(args); } catch { return ''; }
}

/** Scrape the session URL Claude prints once Remote Control is live. */
function rcUrl(tmuxName) {
  const pane = tmuxSafe(['capture-pane', '-pt', tmuxName, '-S', '-300']);
  const m = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(pane);
  return m ? m[0] : null;
}

function rcList() {
  // tmux rewrites tabs in format strings, so use an explicit separator.
  const out = tmuxSafe(['list-sessions', '-F', '#{session_name}|#{session_created}|#{session_path}']);
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith(RC_PREFIX)) continue;
    const [name, created, cwd] = line.split('|');
    rows.push({
      tmuxName: name,
      cwd,
      title: name.slice(RC_PREFIX.length).replace(/-[a-z0-9]{6,}$/, ''),
      createdAt: Number(created) * 1000,
      url: rcUrl(name),
    });
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

function rcCreate(cwd, label) {
  const base = (label || path.basename(cwd)).replace(/[^\w一-龥-]/g, '');
  const name = `${RC_PREFIX}${base}-${Date.now().toString(36)}`;
  const display = `${path.basename(cwd)} · phone`;
  tmux(['new-session', '-d', '-s', name, '-c', cwd,
        `${CLAUDE} --remote-control ${JSON.stringify(display)}`]);
  // Dismiss a first-run dialog if one happens to be in the way.
  setTimeout(() => tmuxSafe(['send-keys', '-t', name, 'Escape']), 4000);
  return name;
}

async function rcWaitUrl(name, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const u = rcUrl(name);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 900));
  }
  return null;
}

// ---------- web-mode sessions (headless streaming) ----------
const sessions = new Map();

function createSession({ cwd, model, resumeId }) {
  const id = randomUUID();
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', PERMISSION_MODE,
    '--model', model || MODEL,
  ];
  if (resumeId) args.push('--resume', resumeId);
  else args.push('--session-id', id);

  const proc = spawn(CLAUDE, args, {
    cwd,
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const s = {
    id, cwd, model: model || MODEL,
    title: path.basename(cwd),
    proc,
    events: [],
    clients: new Set(),
    busy: false,
    alive: true,
    claudeSessionId: resumeId || id,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  sessions.set(id, s);

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handleClaudeMessage(s, JSON.parse(line)); } catch { /* non-JSON noise */ }
    }
  });
  proc.stderr.on('data', (c) => {
    const t = c.toString('utf8').trim();
    if (t) push(s, { type: 'stderr', text: t });
  });
  proc.on('exit', (code) => {
    s.alive = false; s.busy = false;
    push(s, { type: 'exit', code });
    for (const c of s.clients) { try { c.end(); } catch {} }
  });

  return s;
}

function push(s, ev) {
  ev.t = Date.now();
  s.lastActivity = ev.t;
  s.events.push(ev);
  if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of s.clients) { try { c.write(data); } catch {} }
}

function handleClaudeMessage(s, m) {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        if (m.session_id) s.claudeSessionId = m.session_id;
        push(s, { type: 'ready', model: m.model, cwd: m.cwd });
      }
      break;
    case 'stream_event': {
      const e = m.event;
      if (!e) break;
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        push(s, { type: 'tool', name: e.content_block.name });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        push(s, { type: 'delta', text: e.delta.text });
      } else if (e.type === 'message_stop') {
        push(s, { type: 'turn_end' });
      }
      break;
    }
    case 'assistant':
      // Synthetic messages (auth failures, API errors) never stream.
      if (m.is_api_error_message || m.message?.model === '<synthetic>') {
        const t = (m.message?.content || [])
          .filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (t) push(s, { type: 'error', text: t });
      }
      break;
    case 'result':
      s.busy = false;
      if (m.is_error && m.result) push(s, { type: 'error', text: String(m.result) });
      push(s, { type: 'done', cost: m.total_cost_usd, ms: m.duration_ms, error: m.is_error || false });
      break;
  }
}

function sendToSession(s, text) {
  if (!s.alive) throw new Error('session ended');
  push(s, { type: 'user', text });
  s.busy = true;
  s.proc.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n');
}

function lastAssistantText(s) {
  let out = '';
  for (let i = s.events.length - 1; i >= 0 && out.length < 200; i--) {
    const e = s.events[i];
    if (e.type === 'user') break;
    if (e.type === 'delta') out = e.text + out;
  }
  return out.trim();
}

// ---------- screen mode (see and drive the Mac itself) ----------
/** One capture process feeds every viewer. It starts when someone opens the
 *  screen and stops shortly after the last one leaves, so an unwatched Perch
 *  costs nothing. Frames arrive length-prefixed; see input/perch-capture.swift. */
const screen = {
  proc: null,
  clients: new Set(),
  waiters: [],
  last: null,
  lastAt: 0,
  size: null,      // { pointW, pointH, frameW, frameH } — points for input math
  error: null,
  stopTimer: null,
  failedAt: 0,
  opts: { width: 1100, fps: 5, quality: 0.45 },
};
const SCREEN_IDLE_MS = 10000;

const SCREEN_RETRY_MS = 15000;

function screenStart() {
  if (screen.proc) return;
  // A capture that died on a missing permission will die again; don't spawn a
  // doomed process for every poll while the grant is still off.
  if (Date.now() - screen.failedAt < SCREEN_RETRY_MS) return;
  clearTimeout(screen.stopTimer);
  screen.stopTimer = null;
  if (!fs.existsSync(CAPTURE_BIN)) { screen.error = 'perch-capture not built (run ./start.sh)'; return; }

  const { width, fps, quality } = screen.opts;
  const proc = spawn(CAPTURE_BIN,
    ['--width', String(width), '--fps', String(fps), '--quality', String(quality)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  screen.proc = proc;
  screen.error = null;

  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 4) break;
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) break;
      screenFrame(Buffer.from(buf.subarray(4, 4 + n)));
      buf = buf.subarray(4 + n);
    }
  });
  proc.stderr.on('data', (c) => {
    const t = c.toString('utf8');
    const m = /display (\d+)x(\d+) -> (\d+)x(\d+)/.exec(t);
    if (m) screen.size = { pointW: +m[1], pointH: +m[2], frameW: +m[3], frameH: +m[4] };
    else if (t.trim()) screen.error = t.trim();
  });
  proc.on('exit', (code) => {
    screen.proc = null;
    if (code) {
      screen.failedAt = Date.now();
      screen.error = screen.error || `capture exited (${code})`;
    }
  });
}

function screenStop() {
  clearTimeout(screen.stopTimer);
  screen.stopTimer = null;
  if (screen.proc) { try { screen.proc.kill('SIGTERM'); } catch {} }
  screen.proc = null;
}

function screenIdleCheck() {
  if (screen.clients.size || !screen.proc) return;
  clearTimeout(screen.stopTimer);
  screen.stopTimer = setTimeout(screenStop, SCREEN_IDLE_MS);
}

function screenFrame(jpeg) {
  screen.last = jpeg;
  screen.lastAt = Date.now();
  for (const w of screen.waiters.splice(0)) w(jpeg);

  const head = Buffer.from(
    `--perchframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  for (const c of screen.clients) {
    // Drop frames for a viewer whose socket is behind rather than queueing
    // megabytes of stale desktop for a phone on a slow link.
    if (c.busy) continue;
    try {
      c.busy = !c.res.write(Buffer.concat([head, jpeg, Buffer.from('\r\n')]));
      if (c.busy) c.res.once('drain', () => { c.busy = false; });
    } catch { screen.clients.delete(c); }
  }
}

function nextFrame(timeoutMs = 4000) {
  return new Promise((resolve) => {
    screenStart();
    if (screen.last && Date.now() - screen.lastAt < 900) return resolve(screen.last);
    const t = setTimeout(() => {
      screen.waiters = screen.waiters.filter((w) => w !== done);
      resolve(screen.last);
    }, timeoutMs);
    const done = (f) => { clearTimeout(t); resolve(f); };
    screen.waiters.push(done);
  });
}

const screenLog = [];
function logScreen(kind, data) {
  screenLog.push({ t: new Date().toISOString().slice(11, 23), kind, ...data });
  if (screenLog.length > 200) screenLog.splice(0, screenLog.length - 200);
}

function input(args) {
  logScreen('exec', { args: args.join(' ') });
  const r = require('node:child_process').spawnSync(INPUT_BIN, args.map(String),
    { encoding: 'utf8', timeout: 15000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || 'input failed').trim());
  return (r.stdout || '').trim();
}

/** Synthetic events are silently swallowed when Accessibility is off, so the
 *  only honest check is to move the pointer and see whether it moved. */
function inputProbe() {
  try {
    const [x, y] = input(['pos']).split(',').map(Number);
    input(['move', x + 2, y]);
    const [x2] = input(['pos']).split(',').map(Number);
    input(['move', x, y]);
    return x2 === x + 2 ? 'ok' : 'denied';
  } catch (e) {
    return 'unavailable';
  }
}

/** Viewers send 0..1 coordinates so they never need to know the Retina scale. */
function toPoint(v, span) {
  const n = Math.max(0, Math.min(1, Number(v)));
  return Math.round(n * span);
}

function screenPoint(body) {
  const size = screen.size || { pointW: 1470, pointH: 956 };
  return [toPoint(body.x, size.pointW), toPoint(body.y, size.pointH)];
}

// ---------- http ----------
function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function authed(req, url) {
  if (!TOKEN) return true;
  return url.searchParams.get('token') === TOKEN || req.headers['x-perch-token'] === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  let m;

  if (p !== '/health' && !authed(req, url)) return json(res, 401, { error: 'unauthorized' });

  try {
    if (p === '/health') return json(res, 200, { ok: true });

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public/index.html')));
    }

    if (p === '/api/projects' && req.method === 'GET') {
      return json(res, 200, { projects: listProjects() });
    }

    // --- screen mode ---
    if (p === '/api/screen/info' && req.method === 'GET') {
      screenStart();
      return json(res, 200, {
        size: screen.size,
        capturing: !!screen.proc,
        viewers: screen.clients.size,
        hasFrame: !!screen.last,
        opts: screen.opts,
        error: screen.error,
        input: url.searchParams.get('probe') ? inputProbe() : undefined,
      });
    }

    if (p === '/api/screen/opts' && req.method === 'POST') {
      const body = await readBody(req);
      const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
      screen.opts = {
        width: clamp(body.width, 480, 2560, screen.opts.width),
        fps: clamp(body.fps, 1, 15, screen.opts.fps),
        quality: clamp(body.quality, 0.2, 0.9, screen.opts.quality),
      };
      screenStop();          // picked up when the next viewer connects
      if (screen.clients.size) screenStart();
      return json(res, 200, { opts: screen.opts });
    }

    if (p === '/api/screen/frame.jpg' && req.method === 'GET') {
      const f = await nextFrame();
      screenIdleCheck();
      if (!f) return json(res, 503, { error: screen.error || 'no frame yet' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': f.length, 'cache-control': 'no-store' });
      return res.end(f);
    }

    if (p === '/api/screen/stream' && req.method === 'GET') {
      screen.failedAt = 0;
      screenStart();
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=perchframe',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const client = { res, busy: false };
      screen.clients.add(client);
      if (screen.last) screenFrame(screen.last);   // paint immediately
      req.on('close', () => { screen.clients.delete(client); screenIdleCheck(); });
      return;
    }

    if (p === '/api/screen/debug' && req.method === 'GET') {
      return json(res, 200, { log: screenLog.slice(-120) });
    }

    if (p === '/api/screen/debug' && req.method === 'POST') {
      logScreen('client', await readBody(req));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/screen/input' && req.method === 'POST') {
      const body = await readBody(req);
      const [x, y] = screenPoint(body);
      switch (body.action) {
        case 'click':
          input(['click', x, y, body.button || 'left', body.count || 1]);
          break;
        case 'move':
          input(['move', x, y]);
          break;
        case 'drag': {
          const size = screen.size || { pointW: 1470, pointH: 956 };
          input(['drag', x, y, toPoint(body.toX, size.pointW), toPoint(body.toY, size.pointH)]);
          break;
        }
        case 'scroll':
          input(['scroll', x, y, Math.round(body.dx || 0), Math.round(body.dy || 0)]);
          break;
        case 'type':
          if (!body.text) return json(res, 400, { error: 'empty text' });
          input(['type', body.text]);
          break;
        case 'key':
          if (!body.key) return json(res, 400, { error: 'no key' });
          input(['key', body.key, body.mods || '']);
          break;
        default:
          return json(res, 400, { error: 'unknown action' });
      }
      return json(res, 200, { ok: true });
    }

    // --- app mode ---
    if (p === '/api/rc' && req.method === 'GET') {
      return json(res, 200, { sessions: rcList() });
    }

    if (p === '/api/rc' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.cwd || !fs.existsSync(body.cwd)) return json(res, 400, { error: 'bad cwd' });
      const name = rcCreate(body.cwd, body.label);
      return json(res, 200, { tmuxName: name, url: await rcWaitUrl(name), cwd: body.cwd });
    }

    if ((m = /^\/api\/rc\/([\w一-龥-]+)$/.exec(p)) && req.method === 'DELETE') {
      tmuxSafe(['kill-session', '-t', m[1]]);
      return json(res, 200, { ok: true });
    }

    // --- web mode ---
    if (p === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, {
        sessions: [...sessions.values()].map((s) => ({
          id: s.id, cwd: s.cwd, title: s.title, alive: s.alive, busy: s.busy,
          model: s.model, createdAt: s.createdAt, lastActivity: s.lastActivity,
          preview: lastAssistantText(s).slice(-120),
        })).sort((a, b) => b.lastActivity - a.lastActivity),
      });
    }

    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.cwd || !fs.existsSync(body.cwd)) return json(res, 400, { error: 'bad cwd' });
      const s = createSession({ cwd: body.cwd, model: body.model, resumeId: body.resumeId });
      if (body.text) setTimeout(() => { try { sendToSession(s, body.text); } catch {} }, 300);
      return json(res, 200, { id: s.id, cwd: s.cwd });
    }

    if ((m = /^\/api\/sessions\/([\w-]+)\/events$/.exec(p))) {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: 'no session' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'replay', events: s.events, alive: s.alive, busy: s.busy })}\n\n`);
      s.clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ping); s.clients.delete(res); });
      return;
    }

    if ((m = /^\/api\/sessions\/([\w-]+)\/message$/.exec(p)) && req.method === 'POST') {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: 'no session' });
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'empty' });
      sendToSession(s, body.text);
      return json(res, 200, { ok: true });
    }

    if ((m = /^\/api\/sessions\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
      const s = sessions.get(m[1]);
      if (s) { try { s.proc.kill('SIGTERM'); } catch {} sessions.delete(s.id); }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`perch listening on ${HOST}:${PORT}`);
  console.log(`claude: ${CLAUDE}`);
  console.log(`tmux:   ${TMUX}`);
});
