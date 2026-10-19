// ---------------------------------------------------------------------------
// qBittorrent engine
// ---------------------------------------------------------------------------
// Drives an existing qBittorrent instance through its Web API (v2) instead of
// running our own BitTorrent client. Same interface as the built-in engine:
//   add(magnet) -> { infoHash, name, files }
//   stats(hash) -> { name, progress, numPeers, downloadSpeed, ... }
//   stream(hash, fileIndex, req, res)
//   remove(hash)
//
// Requires qBittorrent with "Web User Interface (Remote control)" enabled, and
// the helper must run on the SAME machine as qBittorrent (it reads the finished
// files from disk, because qBittorrent has no streaming API).
//
// Env: QBITTORRENT_URL (default http://localhost:8080),
//      QBITTORRENT_USER (default admin), QBITTORRENT_PASS.
// ---------------------------------------------------------------------------

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mimeOf (name) {
  const e = String(name).toLowerCase().split('.').pop()
  return ({
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    ogv: 'video/ogg', mov: 'video/quicktime', avi: 'video/x-msvideo'
  })[e] || 'application/octet-stream'
}

function hashFromMagnet (magnet) {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || '')
  if (!m) return null
  const h = m[1]
  return /^[a-f0-9]{40}$/i.test(h) ? h.toLowerCase() : null // base32 left to the newest-torrent fallback
}

export class QbittorrentEngine {
  constructor (opts = {}) {
    this.url = String(opts.url || process.env.QBITTORRENT_URL || 'http://localhost:8080').replace(/\/+$/, '')
    this.username = opts.username ?? process.env.QBITTORRENT_USER ?? 'admin'
    this.password = opts.password ?? process.env.QBITTORRENT_PASS ?? ''
    this.sid = null
    this.cache = new Map() // hash -> { name, savePath, files:[{name,size,offset}], pieceSize, raw }
  }

  // Minimal HTTP client (no global fetch) so this works identically on any Node.
  _request (endpoint, { method = 'GET', form, params } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url + '/api/v2/' + endpoint)
      if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
      const headers = { Referer: this.url, Origin: this.url }
      if (this.sid) headers.Cookie = 'SID=' + this.sid
      let body
      if (form) {
        body = new URLSearchParams(form).toString()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        headers['Content-Length'] = Buffer.byteLength(body)
      }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const sc = res.headers['set-cookie']
          if (sc) {
            const m = /SID=([^;]+)/.exec(Array.isArray(sc) ? sc.join('; ') : sc)
            if (m) this.sid = m[1]
          }
          if (res.statusCode === 403) this.sid = null // session expired; next call re-logs in
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: raw.toString('utf8'),
            json: () => { try { return JSON.parse(raw.toString('utf8')) } catch { return null } }
          })
        })
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }

  async login () {
    const r = await this._request('auth/login', { method: 'POST', form: { username: this.username, password: this.password } })
    if (r.text.trim() !== 'Ok.') throw new Error('qBittorrent login failed ("' + r.text.trim() + '") — check QBITTORRENT_USER/QBITTORRENT_PASS or disable auth')
    return true
  }

  async ensureLogin () { if (!this.sid) await this.login() }

  async refresh (hash) {
    await this.ensureLogin()
    const t = (await this._request('torrents/info', { params: { hashes: hash } })).json()
    const info = Array.isArray(t) ? t[0] : null
    if (!info) throw new Error('torrent not found in qBittorrent: ' + hash)
    const filesRaw = (await this._request('torrents/files', { params: { hash } })).json() || []
    const props = (await this._request('torrents/properties', { params: { hash } })).json() || {}

    let offset = 0
    const files = filesRaw.map((f) => { const rec = { name: f.name, size: f.size, offset }; offset += f.size; return rec })
    const rec = { name: info.name, savePath: info.save_path, files, pieceSize: props.piece_size || 0, raw: info }
    this.cache.set(hash, rec)
    return rec
  }

  async add (magnet) {
    await this.ensureLogin()
    const r = await this._request('torrents/add', {
      method: 'POST',
      form: { urls: magnet, sequentialDownload: 'true', firstLastPiecePrio: 'true' }
    })
    if (r.status !== 200) throw new Error('torrents/add HTTP ' + r.status)

    let hash = hashFromMagnet(magnet)
    if (!hash) {
      await sleep(600)
      const list = (await this._request('torrents/info')).json() || []
      list.sort((a, b) => (b.added_on || 0) - (a.added_on || 0))
      hash = list[0] && list[0].hash
    }
    if (!hash) throw new Error('could not determine info hash from qBittorrent')

    for (let i = 0; i < 60; i++) {
      try {
        const rec = await this.refresh(hash)
        if (rec.files.length) {
          return {
            infoHash: hash,
            name: rec.name,
            files: rec.files.map((f, idx) => ({ i: idx, name: f.name, length: f.size, type: mimeOf(f.name) }))
          }
        }
      } catch { /* metadata not ready yet */ }
      await sleep(1000)
    }
    throw new Error('timed out waiting for qBittorrent metadata')
  }

  async stats (hash) {
    const rec = await this.refresh(hash)
    const t = rec.raw
    return {
      name: t.name,
      progress: t.progress,
      numPeers: (t.num_leechs || 0) + (t.num_seeds || 0),
      downloadSpeed: t.dlspeed,
      uploadSpeed: t.upspeed,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      length: t.size,
      timeRemaining: t.eta > 0 ? t.eta * 1000 : 0,
      done: t.progress >= 1
    }
  }

  async remove (hash) {
    await this.ensureLogin()
    await this._request('torrents/delete', { method: 'POST', form: { hashes: hash, deleteFiles: 'false' } })
    this.cache.delete(hash)
  }

  // Wait until the pieces covering [fromByte,toByte] are fully downloaded (state 2).
  async waitForBytes (hash, fromByte, toByte, timeoutMs = 60000) {
    const rec = this.cache.get(hash) || await this.refresh(hash)
    if (!rec.pieceSize) return true
    const pStart = Math.floor(fromByte / rec.pieceSize)
    const pEnd = Math.floor(toByte / rec.pieceSize)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const r = await this._request('torrents/pieceStates', { params: { hash } })
      if (r.status !== 200) return true // unsupported on this qBittorrent version
      const states = r.json()
      if (!Array.isArray(states)) return true
      let ok = true
      for (let p = pStart; p <= pEnd; p++) { if (states[p] !== 2) { ok = false; break } }
      if (ok) return true
      if (Date.now() > deadline) throw new Error('timed out waiting for pieces ' + pStart + '-' + pEnd)
      await sleep(700)
    }
  }

  async stream (hash, fileIndex, req, res) {
    const rec = this.cache.get(hash) || await this.refresh(hash)
    const file = rec.files[fileIndex]
    if (!file) { res.writeHead(404); return res.end('file not found') }

    // Prioritise this file and download it in order.
    try {
      await this._request('torrents/filePrio', { method: 'POST', form: { hash, id: String(fileIndex), priority: '1' } })
      await this._request('torrents/toggleSequentialDownload', { method: 'POST', form: { hashes: hash } })
    } catch { /* non-fatal */ }

    const total = file.size
    const range = req.headers.range
    const headers = { 'Content-Type': mimeOf(file.name), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
    const filePath = path.join(rec.savePath, file.name)

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || []
      let start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : total - 1
      if (Number.isNaN(start) || start < 0) start = 0
      if (Number.isNaN(end) || end >= total) end = total - 1
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end() }
      await this.waitForBytes(hash, file.offset + start, file.offset + end)
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 })
      return fs.createReadStream(filePath, { start, end }).pipe(res)
    }

    await this.waitForBytes(hash, file.offset, file.offset + total - 1)
    res.writeHead(200, { ...headers, 'Content-Length': total })
    return fs.createReadStream(filePath).pipe(res)
  }
}
