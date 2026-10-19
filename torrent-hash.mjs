// Minimal bencode decoder/encoder + info-hash extraction.
// Used to turn a .torrent file into a magnet link server-side (a browser can't
// fetch the .torrent from archive.org because that host sends no CORS header).

import crypto from 'node:crypto'

export function bdecode (buf) {
  let i = 0
  function parse () {
    const c = buf[i]
    if (c === 0x69) { // 'i' integer
      i++
      let n = 0
      let neg = false
      if (buf[i] === 0x2d) { neg = true; i++ }
      while (buf[i] !== 0x65) { n = n * 10 + (buf[i] - 0x30); i++ }
      i++ // skip 'e'
      return neg ? -n : n
    }
    if (c === 0x6c) { // 'l' list
      i++
      const out = []
      while (buf[i] !== 0x65) out.push(parse())
      i++
      return out
    }
    if (c === 0x64) { // 'd' dict
      i++
      const out = {}
      while (buf[i] !== 0x65) {
        const k = parse()
        out[Buffer.isBuffer(k) ? k.toString('utf8') : String(k)] = parse()
      }
      i++
      return out
    }
    // byte string: <len>:<bytes>
    let len = 0
    while (buf[i] !== 0x3a) { len = len * 10 + (buf[i] - 0x30); i++ }
    i++ // skip ':'
    const s = buf.subarray(i, i + len)
    i += len
    return s
  }
  return parse()
}

export function bencode (v) {
  if (typeof v === 'number') return Buffer.from('i' + v + 'e')
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length + ':'), v])
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')])
  if (v && typeof v === 'object') {
    // preserve insertion order; ASCII keys round-trip byte-identically
    const parts = [Buffer.from('d')]
    for (const k of Object.keys(v)) {
      parts.push(bencode(Buffer.from(k, 'utf8')), bencode(v[k]))
    }
    parts.push(Buffer.from('e'))
    return Buffer.concat(parts)
  }
  throw new Error('bencode: unsupported type ' + typeof v)
}

export function infoHashFromTorrent (buf) {
  const decoded = bdecode(buf)
  if (!decoded || !decoded.info) throw new Error('not a valid torrent (no info dict)')
  const hash = crypto.createHash('sha1').update(bencode(decoded.info)).digest('hex')
  const name = decoded.info.name ? decoded.info.name.toString('utf8') : ''
  const trackers = []
  if (decoded.announce) trackers.push(decoded.announce.toString('utf8'))
  if (Array.isArray(decoded['announce-list'])) {
    for (const tier of decoded['announce-list']) {
      for (const t of (Array.isArray(tier) ? tier : [tier])) {
        const s = Buffer.isBuffer(t) ? t.toString('utf8') : String(t)
        if (!trackers.includes(s)) trackers.push(s)
      }
    }
  }
  return { infoHash: hash, name, trackers }
}

export function buildMagnet ({ infoHash, name, trackers = [] }) {
  let m = 'magnet:?xt=urn:btih:' + infoHash
  if (name) m += '&dn=' + encodeURIComponent(name)
  for (const t of trackers) m += '&tr=' + encodeURIComponent(t)
  return m
}
