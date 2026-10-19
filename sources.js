// ---------------------------------------------------------------------------
// Search-source plugin system
// ---------------------------------------------------------------------------
// A "source" is a small object that knows how to search one catalogue and open
// a result. Add your own with SearchPlugins.register({...}).
//
//   {
//     id:   'my-source',                 // unique
//     name: 'My Catalogue',              // shown in the dropdown
//     home: 'https://example.org',       // optional, shown as a hint
//     async search(query) -> [Result],   // Result = { id, title, year?, meta?, raw }
//     async open(result, ctx) -> {       // ctx = { backendUrl }
//       title,                           // display name
//       playUrl?,                        // direct video URL the <video> can load
//       torrentUrl?,                     // link to a .torrent file (optional)
//       magnet?,                         // magnet link (optional)
//       note?                            // small note shown under the player
//     }
//   }
//
// Only add sources you are legally entitled to use. Scrapers for unlicensed
// torrent indexes are out of scope for this project.
// ---------------------------------------------------------------------------

window.SearchPlugins = {
  list: [],
  register (p) { this.list.push(p); return p },
  get (id) { return this.list.find(p => p.id === id) }
}

// ---- helper: ask the backend to turn an Internet Archive item into a magnet
// (the browser can't: the .torrent host sends no CORS header). Returns null if
// no backend is configured or it fails.
async function backendMagnet (ctx, identifier) {
  const backend = (ctx && ctx.backendUrl || '').trim().replace(/\/$/, '')
  if (!backend) return null
  try {
    const r = await fetch(backend + '/api/ia/magnet?identifier=' + encodeURIComponent(identifier))
    if (!r.ok) return null
    const d = await r.json()
    return d.magnet || null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Source 1 — Internet Archive (public-domain / Creative-Commons films)
// ---------------------------------------------------------------------------
SearchPlugins.register({
  id: 'internet-archive',
  name: 'Internet Archive',
  home: 'https://archive.org',
  async search (q) {
    const query = `mediatype:(movies) AND collection:(feature_films) AND title:(${q})`
    const url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(query)
      + '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=downloads'
      + '&rows=20&sort[]=downloads+desc&output=json'
    const d = await (await fetch(url)).json()
    return (d.response.docs || []).map(x => ({
      id: x.identifier,
      title: x.title || x.identifier,
      year: x.year,
      meta: (x.downloads || 0).toLocaleString() + ' downloads',
      raw: x
    }))
  },
  async open (result, ctx) {
    const id = result.id
    const m = await (await fetch('https://archive.org/metadata/' + encodeURIComponent(id))).json()
    const files = m.files || []
    const vids = files.filter(f => /\.(mp4|m4v|webm|ogv)$/i.test(f.name))
    const mp4 = vids.filter(f => /\.(mp4|m4v)$/i.test(f.name))
    const file = (mp4.length ? mp4 : vids).sort((a, b) => Number(b.size) - Number(a.size))[0]
    if (!file) return { title: result.title, note: 'No browser-playable video in this item.' }
    const playUrl = 'https://archive.org/download/' + encodeURIComponent(id) + '/'
      + file.name.split('/').map(encodeURIComponent).join('/')
    const torrentUrl = 'https://archive.org/download/' + encodeURIComponent(id) + '/'
      + encodeURIComponent(id) + '_archive.torrent'
    const magnet = await backendMagnet(ctx, id)
    return {
      title: result.title,
      playUrl, torrentUrl, magnet,
      note: file.name + ' — ' + (Number(file.size) / 1048576).toFixed(1) + ' MB'
    }
  }
})

// ---------------------------------------------------------------------------
// Source 2 — Wikimedia Commons (freely licensed video)
// ---------------------------------------------------------------------------
SearchPlugins.register({
  id: 'wikimedia-commons',
  name: 'Wikimedia Commons',
  home: 'https://commons.wikimedia.org',
  async search (q) {
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*'
      + '&generator=search&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url%7Csize%7Cmime'
      + '&gsrsearch=' + encodeURIComponent('filetype:video ' + q)
    const d = await (await fetch(url)).json()
    const pages = (d.query && d.query.pages) || {}
    return Object.values(pages).map(p => {
      const ii = (p.imageinfo || [{}])[0]
      return {
        id: p.title,
        title: p.title.replace(/^File:/, ''),
        meta: ii.mime ? ii.mime.replace('video/', '') : '',
        raw: { url: (ii.url || '').split('?')[0], size: ii.size, mime: ii.mime }
      }
    }).filter(r => r.raw.url)
  },
  async open (result) {
    return {
      title: result.title,
      playUrl: result.raw.url,
      note: result.raw.mime || 'video'
    }
  }
})
