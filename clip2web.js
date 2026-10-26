#!/usr/bin/env node
/*
 * clip2web.js - save Windows clipboard images to a folder and publish them
 * as a self-refreshing web page with history navigation.
 *
 * Usage:
 *   node clip2web.js --dir C:\www\clip            (watch only; serve the folder with Caddy)
 *   node clip2web.js --dir C:\www\clip --port 8080 (watch + built-in web server, no Caddy needed)
 *
 * Options:
 *   --dir  <path>   Output folder (default ./clip-out)
 *   --port <n>      Also serve the folder over HTTP on this port
 *   --keep <n>      Keep only the newest n images (default 50, 0 = keep all)
 *
 * Page URLs:
 *   /                          live view: follows the newest image
 *   /?file=img-123456.png      pinned view of one specific image (use the Live button to resume)
 *
 * Folder contents: img-<timestamp>.png, latest.json (newest + full list), index.html (rewritten on start).
 * No npm packages required. Windows only (uses PowerShell for clipboard access).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DIR = path.resolve(opt('dir', './clip-out'));
const PORT = parseInt(opt('port', '0'), 10);
const KEEP = parseInt(opt('keep', '50'), 10);

if (process.platform !== 'win32') {
  console.error('This tool reads the Windows clipboard and only runs on Windows.');
  process.exit(1);
}
fs.mkdirSync(DIR, { recursive: true });

// ---------- the web page ----------
const INDEX_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clipboard</title>
<style>
  html,body{margin:0;height:100%;background:#111;color:#aaa;font:14px system-ui,sans-serif;
            -webkit-tap-highlight-color:transparent}
  #wrap{height:100%;display:flex;align-items:center;justify-content:center;overflow:auto;touch-action:pan-y}
  img{max-width:100%;max-height:100%;object-fit:contain;display:block}
  img.full{max-width:none;max-height:none;object-fit:none}
  #msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  #dot{position:fixed;right:8px;top:8px;width:8px;height:8px;border-radius:50%;background:#2a2}
  #dot.off{background:#a22}
  #bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;
       background:rgba(30,30,30,.85);padding:6px 10px;border-radius:999px;backdrop-filter:blur(6px);
       opacity:.35;transition:opacity .2s}
  #bar:hover,#bar:focus-within,#bar.active{opacity:1}
  #bar button{font:inherit;color:#eee;background:#333;border:0;border-radius:999px;
              min-width:48px;height:40px;padding:0 14px;cursor:pointer}
  #bar button:disabled{opacity:.3;cursor:default}
  #bar button#live{background:#235a2a}
  #bar button#live[hidden]{display:none}
  #count{min-width:64px;text-align:center;font-variant-numeric:tabular-nums}
</style></head><body>
<div id="wrap"><img id="img" alt="" hidden></div>
<div id="msg">Waiting for an image...</div>
<div id="dot" title="connection"></div>
<div id="bar" hidden>
  <button id="prev" title="Older (Left arrow)">&#9664;</button>
  <span id="count"></span>
  <button id="next" title="Newer (Right arrow)">&#9654;</button>
  <button id="live" title="Follow newest (End)">Live</button>
</div>
<script>
  const $ = id => document.getElementById(id);
  const img = $('img'), msg = $('msg'), dot = $('dot'), bar = $('bar');
  const prevBtn = $('prev'), nextBtn = $('next'), liveBtn = $('live'), count = $('count');

  let files = [];      // oldest -> newest
  let latest = null;   // newest filename
  let pinned = null;   // filename pinned via ?file= or by navigating back; null = live
  let shown = null;    // filename currently displayed
  let token = 0;

  // Allow only a plain filename in the query string.
  function cleanName(n) {
    if (!n) return null;
    n = n.replace(/^.*[\\\\/]/, '');
    return /^[\\w.\\-]+$/.test(n) ? n : null;
  }
  pinned = cleanName(new URLSearchParams(location.search).get('file'));

  function setUrl() {
    const u = new URL(location.href);
    if (pinned) u.searchParams.set('file', pinned); else u.searchParams.delete('file');
    history.replaceState(null, '', u);
  }

  function target() { return pinned || latest; }

  function render() {
    const t = target();
    if (!t) return;
    msg.hidden = true;
    bar.hidden = false;
    if (t !== shown) {
      const my = ++token;
      const pre = new Image();
      pre.onload = () => {
        if (my !== token) return;
        img.src = pre.src;
        img.hidden = false;
        shown = t;
        document.title = t;
      };
      pre.onerror = () => {
        if (my !== token) return;
        msg.textContent = 'Image not found: ' + t;
        msg.hidden = false;
      };
      pre.src = t;
    }
    const i = files.indexOf(t);
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i < 0 || i >= files.length - 1;
    count.textContent = i >= 0 ? (i + 1) + ' / ' + files.length : '? / ' + files.length;
    liveBtn.hidden = !pinned;
  }

  function go(delta) {
    const i = files.indexOf(target());
    if (i < 0) return;
    const ni = Math.max(0, Math.min(files.length - 1, i + delta));
    if (ni === i) return;
    pinned = ni === files.length - 1 ? null : files[ni];   // reaching the newest returns to live
    setUrl();
    render();
  }
  function goLive() { pinned = null; setUrl(); render(); }

  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);
  liveBtn.onclick = goLive;
  img.addEventListener('click', () => img.classList.toggle('full'));   // tap = actual size

  addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'End') goLive();
  });

  // swipe: left = newer, right = older
  let sx = null, sy = null;
  $('wrap').addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || img.classList.contains('full')) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  $('wrap').addEventListener('touchend', e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  async function poll() {
    try {
      const r = await fetch('latest.json?_=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        dot.className = '';
        latest = j.file;
        files = Array.isArray(j.files) && j.files.length ? j.files : [j.file];
        render();
      } else if (r.status !== 404) { dot.className = 'off'; }
    } catch (e) { dot.className = 'off'; }
    setTimeout(poll, 1000);
  }
  poll();
</script></body></html>
`;
fs.writeFileSync(path.join(DIR, 'index.html'), INDEX_HTML);

// ---------- saving ----------
let lastHash = null;

function listImages() {
  return fs.readdirSync(DIR).filter(f => /^img-\d+\.png$/.test(f)).sort();
}

// latest.json = newest image + full ordered list (oldest -> newest), written atomically
function writeState() {
  const files = listImages();
  if (!files.length) return;
  const file = files[files.length - 1];
  const ts = parseInt(file.slice(4), 10);
  const tmp = path.join(DIR, 'latest.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ file, ts, files }));
  fs.renameSync(tmp, path.join(DIR, 'latest.json'));
}

function prune() {
  if (!KEEP) return;
  const imgs = listImages();
  for (const f of imgs.slice(0, Math.max(0, imgs.length - KEEP))) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch {}
  }
}

function saveImage(png) {
  const hash = crypto.createHash('sha1').update(png).digest('hex');
  if (hash === lastHash) return; // same image as last time
  lastHash = hash;

  const file = `img-${Date.now()}.png`;
  fs.writeFileSync(path.join(DIR, file), png);
  prune();
  writeState();

  console.log(`[${new Date().toLocaleTimeString()}] saved ${file} (${(png.length / 1024).toFixed(0)} KB)`);
}

// make history available immediately after a restart
writeState();

// ---------- clipboard watcher (long-lived PowerShell, STA) ----------
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public class CB { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }
"@
$last = [uint32]0
while ($true) {
  $seq = [CB]::GetClipboardSequenceNumber()
  if ($seq -ne $last) {
    $last = $seq
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img -ne $null) {
          $ms = New-Object System.IO.MemoryStream
          $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          $img.Dispose()
          [Console]::Out.WriteLine([Convert]::ToBase64String($ms.ToArray()))
          [Console]::Out.Flush()
        }
      }
    } catch { $last = [uint32]0 }   # clipboard busy - retry next tick
  }
  Start-Sleep -Milliseconds 300
}
`;

function startWatcher() {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const ps = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true });

  readline.createInterface({ input: ps.stdout }).on('line', line => {
    line = line.trim();
    if (!line) return;
    try { saveImage(Buffer.from(line, 'base64')); }
    catch (e) { console.error('save failed:', e.message); }
  });
  ps.stderr.on('data', d => console.error('[powershell]', d.toString().trim()));
  ps.on('exit', code => {
    console.error(`clipboard watcher exited (${code}); restarting in 2s`);
    setTimeout(startWatcher, 2000);
  });
  process.on('exit', () => { try { ps.kill(); } catch {} });
}

// ---------- optional built-in web server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
};

function startServer() {
  http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const full = path.normalize(path.join(DIR, p));
    if (!full.startsWith(DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const headers = { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' };
      if (p === '/latest.json' || p === '/index.html') headers['Cache-Control'] = 'no-store';
      res.writeHead(200, headers);
      res.end(data);
    });
  }).listen(PORT, '0.0.0.0', () => console.log(`serving ${DIR} on http://0.0.0.0:${PORT}/`));
}

// ---------- go ----------
console.log(`watching clipboard -> ${DIR}`);
startWatcher();
if (PORT) startServer();
