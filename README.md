# P2P Streamer

Search public-domain films and stream them, or paste a magnet link. The frontend is a static
site that runs on **GitHub Pages**; the optional torrent engine is a small **Node backend** that
can either run its own BitTorrent client or drive an existing **qBittorrent**.

> **Why the split?** GitHub Pages serves static files only — it cannot run Node or open the
> TCP/UDP sockets BitTorrent needs. So the site lives on Pages and the engine lives on a Node host.

## Layout

```
.
├── site/                      # the static frontend  -> GitHub Pages
│   ├── index.html
│   ├── sources.js             # search-source plugins
│   ├── config.js              # <-- backend URL + default source
│   └── .nojekyll
├── server/                    # the torrent engine   -> Render / Railway / Fly / VPS
│   ├── server.mjs
│   ├── qbittorrent.mjs        # qBittorrent engine (ENGINE=qbittorrent)
│   ├── lib/torrent-hash.mjs
│   └── package.json
└── .github/workflows/pages.yml
```

## Search plugins

The **Search films** tab is driven by plugins in `site/sources.js`. Each plugin knows how to
search one catalogue and open a result:

```js
SearchPlugins.register({
  id, name, home,
  async search(query)          -> [ { id, title, year?, meta?, raw } ],
  async open(result, ctx)      -> { title, playUrl?, torrentUrl?, magnet?, note? }
})
```

Ships with two: **Internet Archive** and **Wikimedia Commons**. Add your own; only use catalogues
you are legally entitled to use — scrapers for unlicensed torrent indexes are out of scope here.

## Two engines

Set `ENGINE` on the backend:

| `ENGINE` | What it does |
| --- | --- |
| *(unset)* `webtorrent` | the backend runs its own BitTorrent client |
| `qbittorrent` | the backend drives **your qBittorrent** via its Web API and streams the files |

For `ENGINE=qbittorrent`, enable qBittorrent's *Web User Interface (Remote control)* and run the
helper on the **same machine** as qBittorrent (it reads finished files from disk, since
qBittorrent has no streaming API). Env:

```
ENGINE=qbittorrent
QBITTORRENT_URL=http://localhost:8080
QBITTORRENT_USER=admin
QBITTORRENT_PASS=yourpassword
```

The engine sets sequential download + file priority, waits for the pieces covering each byte
range to arrive, then serves that range — so playback starts before the download finishes.

## Part A — Put the site on GitHub Pages

```bash
git init && git add . && git commit -m "Initial commit" && git branch -M main
git remote add origin https://github.com/<your-username>/p2p-streamer.git
git push -u origin main
```

Then repo → **Settings → Pages → Source: GitHub Actions**.

## Part B — Deploy the backend

Render: New → **Web Service** → connect this repo → Root directory `server` → Build `npm install`
→ Start `node server.mjs` → env `ALLOW_ORIGIN=https://<your-username>.github.io`
(add the `ENGINE`/`QBITTORRENT_*` vars if you want the qBittorrent engine).

## Part C — Wire them together

Edit `site/config.js`:

```js
window.SITE_CONFIG = { backendUrl: "https://p2p-streamer.onrender.com", defaultSource: "internet-archive" };
```

## Backend API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/add` | body `{"magnet":"..."}` → torrent + file list |
| `GET`  | `/stream/:infoHash/:index` | range-aware video stream |
| `GET`  | `/api/stats/:infoHash` | peers, speed, progress, ETA |
| `POST` | `/api/remove/:infoHash` | stop and delete a torrent |
| `GET`  | `/api/ia/search?q=` | Internet Archive film search |
| `GET`  | `/api/ia/magnet?identifier=` | derive a magnet link for an Archive item |

## Notes and caveats

- **Legal:** use only content you have the right to stream. A site whose main purpose is
  streaming copyrighted films can be taken down, and the backend operator is the one actually
  distributing bytes — the more exposed position legally.
- **Backend cost/abuse:** a public backend spends your bandwidth and CPU on every stream. Add
  rate limiting or an allowlist before sharing the link.
- **qBittorrent mode** needs the helper and qBittorrent on the same machine, and qBittorrent's
  `pieceStates` endpoint (qBittorrent 4.4+) for precise range gating.
- **MKV** won't play in most browsers — pick an MP4 (H.264) or WebM.
