// P2P magnet -> HTTP streamer (server-side BitTorrent client)
// Runs a real BitTorrent client on the server (TCP/uTP/DHT, so it can reach
// normal seeders) and re-serves any file over HTTP with Range support, so a
// plain <video> tag can stream and seek it. This is the model that works for
// arbitrary magnet links; a browser-only client cannot reach TCP peers.
//
//   npm install webtorrent
//   node server.mjs
//   open http://localhost:8080
//
// Legal note: use only for content you have the right to stream.

import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import path from 'node:path'
import fs from 'node:fs'
import WebTorrent from 'webtorrent'
import { infoHashFromTorrent, buildMagnet } from './lib/torrent-hash.mjs'
import { QbittorrentEngine } from './qbittorrent.mjs'

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080
const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads')
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

const client = new WebTorrent()
const torrents = new Map() // infoHash -> torrent

// ENGINE=qbittorrent drives an existing qBittorrent via its Web API instead of
// running our own client. Both engines expose the same interface.
const USE_QB = String(process.env.ENGINE || '').toLowerCase() === 'qbittorrent'
const engine = USE_QB ? new QbittorrentEngine() : null

client.on('error', (err) => console.error('[client error]', err.message))

// Small dependency-free HTTPS GET with redirect following (used for archive.org).
function httpGet (url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: { 'User-Agent': 'p2p-streamer/1.0' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && redirects > 0) {
        r.resume()
        return resolve(httpGet(new URL(r.headers.location, url).toString(), redirects - 1))
      }
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => { const buffer = Buffer.concat(chunks); resolve({ status: r.statusCode, buffer, text: buffer.toString('utf8') }) })
    })
    req.on('error', reject)
  })
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body)
}

function addTorrent(magnet) {
  return new Promise((resolve, reject) => {
    const existing = [...torrents.values()].find((t) => t.magnetURI === magnet)
    if (existing) return resolve(existing)
    let settled = false
    const t = client.add(magnet, { path: DOWNLOAD_DIR }, (torrent) => {
      settled = true
      torrents.set(torrent.infoHash, torrent)
      torrent.on('error', (e) => console.error('[torrent error]', e.message))
      resolve(torrent)
    })
    t.on('error', (e) => { if (!settled) reject(e) })
    setTimeout(() => { if (!settled) reject(new Error('Timed out waiting for metadata (no peers for this magnet?)')) }, 60000)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean)

  // CORS: lets a static frontend on another origin (e.g. GitHub Pages) call this API.
  // Tighten ALLOW_ORIGIN to your Pages URL in production instead of '*'.
  const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*'
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  try {
    // ---- API: add a magnet -------------------------------------------------
    if (req.method === 'POST' && url.pathname === '/api/add') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      let magnet = ''
      try { magnet = JSON.parse(Buffer.concat(chunks).toString() || '{}').magnet || '' } catch {}
      magnet = magnet.trim()
      if (!magnet) return json(res, 400, { error: 'No magnet link provided' })
      if (!/^magnet:\?/i.test(magnet) && !/^[a-f0-9]{40}$/i.test(magnet)) {
        return json(res, 400, { error: 'Not a magnet link or info hash' })
      }
      try {
        if (engine) return json(res, 200, await engine.add(magnet)) // qBittorrent engine
        const t = await addTorrent(magnet)
        const files = t.files.map((f, i) => ({ i, name: f.name, length: f.length, type: f.type || 'application/octet-stream' }))
        return json(res, 200, { infoHash: t.infoHash, name: t.name, files })
      } catch (e) {
        return json(res, 504, { error: e.message })
      }
    }

    // ---- API: Internet Archive search proxy (avoids any browser CORS doubt) --
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'ia' && parts[2] === 'search') {
      const q = url.searchParams.get('q') || ''
      if (!q) return json(res, 400, { error: 'q required' })
      const query = `mediatype:(movies) AND collection:(feature_films) AND title:(${q})`
      const iaUrl = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(query)
        + '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=downloads&rows=20&sort[]=downloads+desc&output=json'
      try {
        const r = await httpGet(iaUrl)
        const d = JSON.parse(r.text)
        return json(res, 200, { docs: (d.response && d.response.docs) || [] })
      } catch (e) { return json(res, 502, { error: e.message }) }
    }

    // ---- API: derive a magnet link for an Internet Archive item ------------
    // The .torrent download host sends no CORS header, so a browser can't read
    // it; the server can, so it computes the info hash and returns a real magnet.
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'ia' && parts[2] === 'magnet') {
      const id = url.searchParams.get('identifier')
      if (!id) return json(res, 400, { error: 'identifier required' })
      const tUrl = 'https://archive.org/download/' + encodeURIComponent(id) + '/' + encodeURIComponent(id) + '_archive.torrent'
      try {
        const r = await httpGet(tUrl)
        if (r.status !== 200) throw new Error('torrent fetch HTTP ' + r.status)
        const info = infoHashFromTorrent(r.buffer)
        return json(res, 200, { ...info, magnet: buildMagnet(info) })
      } catch (e) { return json(res, 502, { error: e.message }) }
    }

    // ---- API: stats --------------------------------------------------------
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'stats' && parts[2]) {
      if (engine) {
        try { return json(res, 200, await engine.stats(parts[2])) }
        catch (e) { return json(res, 404, { error: e.message }) }
      }
      const t = torrents.get(parts[2])
      if (!t) return json(res, 404, { error: 'unknown torrent' })
      return json(res, 200, {
        name: t.name, progress: t.progress, numPeers: t.numPeers,
        downloadSpeed: t.downloadSpeed, uploadSpeed: t.uploadSpeed,
        downloaded: t.downloaded, uploaded: t.uploaded,
        length: t.length, timeRemaining: t.timeRemaining, done: t.done
      })
    }

    // ---- API: remove -------------------------------------------------------
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'remove' && parts[2]) {
      if (engine) {
        try { await engine.remove(parts[2]) } catch (e) { console.error('[remove error]', e.message) }
        return json(res, 200, { ok: true })
      }
      const t = torrents.get(parts[2])
      if (t) {
        try { await client.remove(t.infoHash, { destroyStore: true }) }
        catch (e) { console.error('[remove error]', e.message) }
        torrents.delete(parts[2])
      }
      return json(res, 200, { ok: true })
    }

    // ---- Stream: /stream/:infoHash/:fileIndex ------------------------------
    if (req.method === 'GET' && parts[0] === 'stream' && parts[1] && parts[2] !== undefined) {
      if (engine) {
        try { return await engine.stream(parts[1], Number(parts[2]), req, res) }
        catch (e) { console.error('[stream error]', e.message); if (!res.headersSent) res.writeHead(502); return res.end('stream error: ' + e.message) }
      }
      const t = torrents.get(parts[1])
      if (!t) { res.writeHead(404); return res.end('torrent not added') }
      const file = t.files[Number(parts[2])]
      if (!file) { res.writeHead(404); return res.end('file not found') }

      // Prioritise this file and download its pieces in order for smooth playback.
      file.select()

      const total = file.length
      const range = req.headers.range
      const headers = {
        'Content-Type': file.type || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || []
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : total - 1
        if (Number.isNaN(start) || start < 0) start = 0
        if (Number.isNaN(end) || end >= total) end = total - 1
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end() }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 })
        const stream = file.createReadStream({ start, end })
        stream.on('error', (e) => { console.error('[stream error]', e.message); res.destroy() })
        return stream.pipe(res)
      }

      res.writeHead(200, { ...headers, 'Content-Length': total })
      const stream = file.createReadStream()
      stream.on('error', (e) => { console.error('[stream error]', e.message); res.destroy() })
      return stream.pipe(res)
    }

    // ---- UI ----------------------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(UI)
    }

    res.writeHead(404); res.end('not found')
  } catch (e) {
    console.error('[handler error]', e)
    json(res, 500, { error: e.message })
  }
})

server.listen(PORT, () => {
  console.log(`\n  P2P streamer running:  http://localhost:${PORT}`)
  console.log(`  Downloads land in:     ${DOWNLOAD_DIR}`)
  console.log(`  Paste a magnet link in the page to begin.\n`)
})

export { server, client, torrents, addTorrent, httpGet }

// ---------------------------------------------------------------------------
const UI = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>P2P Magnet Streamer</title>
<style>
:root{--bg:#0b0d12;--panel:#141823;--panel2:#1b2130;--line:#26304a;--ink:#e8ecf5;--muted:#8b96ad;--accent:#5b8cff;--accent2:#22d3a6;--danger:#ff5c6c;--warn:#ffb020}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 700px at 15% -10%,#1a2340,var(--bg) 55%);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding-bottom:60px}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px}
h1{font-size:20px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1.55fr 1fr;gap:20px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:16px}
.player{position:relative;background:#000;border-radius:12px;overflow:hidden;border:1px solid var(--line);aspect-ratio:16/9}
video{width:100%;height:100%;display:block;background:#000}
.overlay{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);padding:24px;text-align:center;pointer-events:none;font-size:14px}
.overlay.hide{display:none}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#0d1220;color:var(--ink);font:13px ui-monospace,Menlo,monospace;outline:none}
input:focus{border-color:var(--accent)}
button{padding:11px 16px;border-radius:10px;border:1px solid var(--line);background:#1e2740;color:var(--ink);font-weight:600;cursor:pointer;margin-top:10px}
button:hover{border-color:var(--accent)}
button.primary{background:linear-gradient(135deg,var(--accent),#3f6fe0);border-color:transparent}
.bar{height:8px;border-radius:999px;background:#0d1220;border:1px solid var(--line);overflow:hidden;margin-top:12px}
.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .3s}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}@media(max-width:520px){.stats{grid-template-columns:1fr 1fr}}
.stat{background:#0d1220;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.stat .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}.stat .v{font-size:16px;font-weight:700;margin-top:2px}
.log{margin-top:12px;max-height:150px;overflow:auto;background:#0a0e18;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:12px ui-monospace,Menlo,monospace;color:var(--muted);white-space:pre-wrap}
.log .ok{color:var(--accent2)}.log .er{color:var(--danger)}.log .wn{color:var(--warn)}
.files{margin-top:12px}.file{display:flex;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:#0d1220;margin-top:7px;font-size:13px;cursor:pointer}
.file:hover{border-color:var(--accent)}.file small{color:var(--muted)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);margin-right:7px;vertical-align:middle}.dot.on{background:var(--accent2)}.dot.wn{background:var(--warn)}
.note{font-size:12px;color:var(--muted);margin-top:14px;line-height:1.6}
</style></head><body><div class="wrap">
<h1>P2P Magnet Streamer</h1>
<div class="sub">Server-side BitTorrent client — it joins the real TCP swarm, so ordinary magnet links work. Streams to the browser over HTTP Range.</div>
<div class="grid">
  <div class="card">
    <div class="player"><video id="v" controls playsinline></video><div class="overlay" id="ov">Add a magnet link to begin</div></div>
    <div class="bar"><i id="prog"></i></div>
    <div class="stats">
      <div class="stat"><div class="k">Downloaded</div><div class="v" id="s-done">0%</div></div>
      <div class="stat"><div class="k">Speed</div><div class="v" id="s-speed">0 KB/s</div></div>
      <div class="stat"><div class="k">Peers</div><div class="v" id="s-peers">0</div></div>
      <div class="stat"><div class="k">ETA</div><div class="v" id="s-eta">—</div></div>
    </div>
    <div class="log" id="log"></div>
  </div>
  <div class="card">
    <label for="m">Magnet link or info hash</label>
    <input id="m" placeholder="magnet:?xt=urn:btih:..." spellcheck="false">
    <button class="primary" id="add">Add &amp; load</button>
    <div class="files" id="files"></div>
    <div class="note"><strong style="color:var(--ink)">Legal content only.</strong> Use this for public-domain, Creative-Commons or otherwise licensed material. Unlicensed streaming/downloading of copyrighted films is illegal in India under the Copyright Act.</div>
  </div>
</div></div>
<script>
const $=id=>document.getElementById(id);let hash=null,timer=null;
const fmt=b=>{const u=['B','KB','MB','GB'];let i=0,n=b||0;while(n>=1024&&i<3){n/=1024;i++}return n.toFixed(n<10?1:0)+' '+u[i]};
const log=(m,c)=>{$('log').innerHTML+='<span class="'+(c||'')+'">'+m+'</span>\\n';$('log').scrollTop=$('log').scrollHeight};
const st=(t,c)=>{$('ov').innerHTML='<div><span class="dot '+(c||'')+'"></span>'+t+'</div>';$('ov').classList.remove('hide')};
$('add').onclick=async()=>{
  const magnet=$('m').value.trim();if(!magnet){log('Paste a magnet link first.','wn');return}
  $('files').innerHTML='';$('log').innerHTML='';st('resolving metadata…','wn');log('Resolving metadata from the swarm (this can take 10-60s)…');
  try{
    const r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({magnet})});
    const d=await r.json();
    if(!r.ok){log('Error: '+d.error,'er');st('metadata failed','wn');return}
    hash=d.infoHash;log('Metadata: '+d.name,'ok');
    const vids=d.files.filter(f=>/\\.(mp4|webm|m4v|mov|ogv|mkv)$/i.test(f.name));
    const list=(vids.length?vids:d.files);
    d.files.forEach(f=>{
      const el=document.createElement('div');el.className='file';
      el.innerHTML='<span>'+f.name+'</span><small>'+fmt(f.length)+'</small>';
      el.onclick=()=>play(d.infoHash,f.i,f.name,f.type);$('files').appendChild(el);
    });
    const first=list.sort((a,b)=>b.length-a.length)[0];
    if(first) play(d.infoHash,first.i,first.name,first.type);
    timer=setInterval(tick,800);
  }catch(e){log('Request failed: '+e.message,'er')}
};
function play(h,i,name,type){
  st('buffering "'+name+'"…','wn');log('Opening stream for '+name);
  $('v').src='/stream/'+h+'/'+i;$('v').play().catch(()=>{});
}
async function tick(){
  if(!hash)return;
  try{const s=await (await fetch('/api/stats/'+hash)).json();
    $('s-done').textContent=(s.progress*100).toFixed(1)+'%';
    $('s-speed').textContent=fmt(s.downloadSpeed)+'/s';
    $('s-peers').textContent=s.numPeers;
    $('s-eta').textContent=s.done?'done':(s.timeRemaining>0?Math.round(s.timeRemaining/1000)+'s':'—');
    $('prog').style.width=(s.progress*100)+'%';
    if(s.numPeers>0){st('streaming — '+s.numPeers+' peer(s)','on')}
  }catch(e){}
}
</script></body></html>`
