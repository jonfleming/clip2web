#!/usr/bin/env node
/*
 * clip2web.js - save Windows clipboard images to a folder and publish them
 * as a self-refreshing web page.
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
 * Folder contents: img-<timestamp>.png, latest.json, index.html (rewritten on start).
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
  html,body{margin:0;height:100%;background:#111;color:#888;font:14px system-ui,sans-serif}
  #wrap{height:100%;display:flex;align-items:center;justify-content:center;overflow:auto}
  img{max-width:100%;max-height:100%;object-fit:contain;display:block}
  img.full{max-width:none;max-height:none;object-fit:none}
  #msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  #dot{position:fixed;right:8px;top:8px;width:8px;height:8px;border-radius:50%;background:#2a2}
  #dot.off{background:#a22}
</style></head><body>
<div id="wrap"><img id="img" alt="" hidden></div>
<div id="msg">Waiting for an image...</div>
<div id="dot" title="connection"></div>
<script>
  const img = document.getElementById('img');
  const msg = document.getElementById('msg');
  const dot = document.getElementById('dot');
  let current = null;
  img.addEventListener('click', () => img.classList.toggle('full')); // tap = actual size
  async function poll() {
    try {
      const r = await fetch('latest.json?_=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        dot.className = '';
        if (j.file && j.file !== current) {
          const pre = new Image();
          pre.onload = () => {
            img.src = pre.src;
            img.hidden = false;
            msg.hidden = true;
            current = j.file;
          };
          pre.src = j.file;
        }
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

function saveImage(png) {
  const hash = crypto.createHash('sha1').update(png).digest('hex');
  if (hash === lastHash) return; // same image as last time
  lastHash = hash;

  const ts = Date.now();
  const file = `img-${ts}.png`;
  fs.writeFileSync(path.join(DIR, file), png);

  // write latest.json atomically so the page never sees a half-written file
  const tmp = path.join(DIR, 'latest.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ file, ts }));
  fs.renameSync(tmp, path.join(DIR, 'latest.json'));

  console.log(`[${new Date().toLocaleTimeString()}] saved ${file} (${(png.length / 1024).toFixed(0)} KB)`);
  prune();
}

function prune() {
  if (!KEEP) return;
  const imgs = fs.readdirSync(DIR).filter(f => /^img-\d+\.png$/.test(f)).sort();
  for (const f of imgs.slice(0, Math.max(0, imgs.length - KEEP))) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch {}
  }
}

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
