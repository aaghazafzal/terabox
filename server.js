/**
 * 🚀 TeraBox Cloud Resolver & Full-Length Stream Engine
 * Author: aaghazafzal (https://github.com/aaghazafzal)
 * 
 * Features:
 *  - Full-Length M3U8 HLS generation (bypasses 30-second preview cutoff)
 *  - Supports 2+ hour full movies, anime, serials, and bonus episodes
 *  - Direct Cloudflare Worker KV integration (/api/cache-stream)
 *  - Range-aware HTTP 206 video chunk proxy with full CORS headers
 *  - Compatible with Render.com, Hugging Face Spaces, Koyeb, Railway, VPS
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ProxyAgent, fetch: uFetch } = require('undici');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_COOKIE = process.env.TERABOX_COOKIE || '';
const DEFAULT_WORKER_URL = process.env.WORKER_URL || 'https://terabox-player-api.cinemahubapi.workers.dev';
const DEFAULT_PROXY = process.env.HTTP_PROXY || process.env.PROXY_URL || '';

function getFetchClient(proxyOverride) {
  const proxy = proxyOverride || DEFAULT_PROXY;
  if (proxy && proxy.trim()) {
    try {
      const agent = new ProxyAgent(proxy.trim());
      return (url, opts = {}) => uFetch(url, { ...opts, dispatcher: agent });
    } catch (e) {
      console.warn('Invalid proxy configuration:', e.message);
    }
  }
  return fetch;
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory cache for ultra-fast repetitive hits (TTL: 4 hours)
const memoryCache = new Map();
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 14400) * 1000;

function getCached(surl) {
  const item = memoryCache.get(surl);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryCache.delete(surl);
    return null;
  }
  return item;
}

function setCached(surl, metadata, m3u8) {
  memoryCache.set(surl, {
    metadata,
    m3u8,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

/**
 * Extracts surl from any TeraBox link format or raw string
 */
function extractSurl(rawInput) {
  if (!rawInput) return null;
  const clean = rawInput.trim();

  // Pure surl string: e.g. "vZU7VbstM8UT_fVepwfWkQ" or "1yyN0lTInlL9ZKtSl5EJWsA"
  if (/^[A-Za-z0-9_-]{15,40}$/.test(clean)) {
    return clean.startsWith('1') ? clean.slice(1) : clean;
  }

  try {
    let target = clean;
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }
    const urlObj = new URL(target);

    if (urlObj.searchParams.has('surl')) {
      const s = urlObj.searchParams.get('surl');
      return s.startsWith('1') ? s.slice(1) : s;
    }

    const match = urlObj.pathname.match(/\/s\/(?:1)?([A-Za-z0-9_-]+)/);
    if (match && match[1]) {
      return match[1];
    }

    const shareMatch = urlObj.pathname.match(/\/sharing\/link\?surl=(?:1)?([A-Za-z0-9_-]+)/);
    if (shareMatch && shareMatch[1]) {
      return shareMatch[1];
    }
  } catch (err) {
    console.error('URL parse error:', err.message);
  }

  return null;
}

function formatDuration(seconds) {
  const s = parseInt(seconds, 10);
  if (isNaN(s) || s <= 0) return '00:00';
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  const b = parseInt(bytes, 10);
  if (isNaN(b) || b <= 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function parseInitialState(html) {
  const token = 'window.__INITIAL_STATE__';
  const start = html.indexOf(token);
  if (start === -1) return null;
  const jsonStart = html.indexOf('{', start);
  if (jsonStart === -1) return null;
  let depth = 0;
  let end = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  try {
    return JSON.parse(html.slice(jsonStart, end));
  } catch {
    return null;
  }
}

function sanitizeCookie(cookieStr) {
  if (!cookieStr) return '';
  let clean = cookieStr.trim();
  if (!clean.includes('ndus=') && !clean.includes(';')) {
    clean = `ndus=${clean}`;
  }
  if (!clean.includes('PANWEB=')) clean += '; PANWEB=1';
  if (!clean.includes('lang=')) clean += '; lang=en';
  return clean;
}

/**
 * Core Resolver: Resolves TeraBox share URL and fetches genuine full-length M3U8
 */
async function resolveTeraBoxStream(surl, options = {}) {
  const cookie = sanitizeCookie(options.cookie || DEFAULT_COOKIE);
  const workerUrl = (options.workerUrl || DEFAULT_WORKER_URL || '').replace(/\/$/, '');
  const reqHost = options.reqHost || `localhost:${PORT}`;
  const reqProtocol = options.reqProtocol || 'http';

  if (!cookie) {
    throw new Error("Missing TeraBox cookie (ndus). Please set TERABOX_COOKIE environment variable or pass 'cookie' parameter.");
  }

  const surlVariations = [surl];
  if (surl.startsWith('1')) surlVariations.push(surl.slice(1));
  else surlVariations.push('1' + surl);

  const wapDomains = [];
  for (const s of surlVariations) {
    wapDomains.push(
      `https://dm.1024tera.com/wap/share/filelist?surl=${s}`,
      `https://www.1024tera.com/wap/share/filelist?surl=${s}`,
      `https://dm.terabox.app/wap/share/filelist?surl=${s}`,
      `https://www.terabox.app/wap/share/filelist?surl=${s}`,
      `https://www.terabox.com/wap/share/filelist?surl=${s}`,
      `https://dm.1024terabox.com/wap/share/filelist?surl=${s}`,
      `https://www.1024terabox.com/wap/share/filelist?surl=${s}`
    );
  }

  const doFetch = getFetchClient(options.proxy);
  let state = null;
  let lastError = null;

  for (const wapUrl of wapDomains) {
    try {
      const res = await doFetch(wapUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          'Cookie': cookie,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      });

      if (!res.ok) continue;

      const html = await res.text();

      if (html.includes('share link error stat') || res.url.includes('/error/404.html')) {
        throw new Error('Link is invalid or has expired (TeraBox Error 404).');
      }

      const parsed = parseInitialState(html);
      if (parsed && parsed.share && parsed.share.fileList && parsed.share.fileList.length > 0) {
        state = parsed;
        break;
      }
    } catch (err) {
      lastError = err;
      if (err.message.includes('expired')) throw err;
    }
  }

  if (!state) {
    throw new Error(lastError ? lastError.message : 'Could not extract TeraBox metadata. TeraBox may require cookie renewal or verification.');
  }

  const share = state.share.shareInfo;
  const file = state.share.fileList[0];

  // Request genuine full-length HLS streaming endpoint
  const streamUrl = new URL('https://dm.terabox.app/share/streaming');
  streamUrl.searchParams.append('app_id', '250528');
  streamUrl.searchParams.append('channel', 'dubox');
  streamUrl.searchParams.append('clienttype', '0');
  streamUrl.searchParams.append('web', '1');
  streamUrl.searchParams.append('uk', share.uk);
  streamUrl.searchParams.append('shareid', share.shareid);
  streamUrl.searchParams.append('timestamp', share.timestamp);
  streamUrl.searchParams.append('sign', share.sign);
  streamUrl.searchParams.append('fid', file.fs_id);
  streamUrl.searchParams.append('type', options.quality || 'M3U8_AUTO_480');

  const combinedCookie = `${cookie}; BDCLND=${decodeURIComponent(share.randsk || '')};`;

  const streamRes = await doFetch(streamUrl.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      'Cookie': combinedCookie,
      'Referer': 'https://www.terabox.app/'
    }
  });

  const rawM3u8 = await streamRes.text();

  if (rawM3u8.startsWith('{') && rawM3u8.includes('"errno"')) {
    throw new Error(`TeraBox streaming API returned error: ${rawM3u8}`);
  }

  // Count TS chunks
  const segmentLines = rawM3u8.split('\n').filter(l => l.startsWith('http://') || l.startsWith('https://'));
  const segmentsCount = segmentLines.length;

  // Rewrite segment URLs to pass through either the Cloudflare Worker proxy or this server's proxy
  const proxyBase = workerUrl ? `${workerUrl}/proxy` : `${reqProtocol}://${reqHost}/proxy`;
  const rewrittenM3u8 = rawM3u8.replace(/(https?:\/\/[^\s\r\n]+)/g, (match) => {
    return `${proxyBase}?url=${encodeURIComponent(match)}&surl=${surl}&name=segment.ts`;
  });

  const durationSec = parseInt(file.duration || 0, 10);
  const sizeBytes = parseInt(file.size || 0, 10);

  const playlistUrl = workerUrl 
    ? `${workerUrl}/playlist/${surl}.m3u8`
    : `${reqProtocol}://${reqHost}/playlist/${surl}.m3u8`;

  const metadata = {
    ok: true,
    mode: "full_hls_stream",
    surl: surl,
    total_files: state.share.fileList.length,
    share_title: file.server_filename || 'video.mp4',
    segments_count: segmentsCount,
    files: [
      {
        fs_id: file.fs_id,
        filename: file.server_filename,
        size_bytes: sizeBytes,
        size_formatted: formatSize(sizeBytes),
        duration_seconds: durationSec,
        duration_formatted: formatDuration(durationSec),
        category: file.category || "1",
        is_dir: false,
        thumbnail: file.thumbs ? (file.thumbs.url3 || file.thumbs.url2 || file.thumbs.url1) : "",
        m3u8_url: playlistUrl,
        stream_url: playlistUrl
      }
    ]
  };

  // Cache locally
  setCached(surl, metadata, rewrittenM3u8);

  // Sync to Cloudflare Worker KV if WORKER_URL is configured
  if (workerUrl) {
    try {
      fetch(`${workerUrl}/api/cache-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surl: surl,
          metadata: metadata,
          m3u8: rewrittenM3u8
        })
      }).catch(err => console.warn('Could not sync to Worker KV:', err.message));
    } catch (e) {
      // non-blocking
    }
  }

  return { metadata, m3u8: rewrittenM3u8 };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Health Check (ideal for Render / UptimeRobot / cron keep-alive)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    workerUrl: DEFAULT_WORKER_URL,
    hasDefaultCookie: Boolean(DEFAULT_COOKIE)
  });
});

// Diagnostic Endpoint to test cookies and domain responses
app.get('/debug', async (req, res) => {
  const surl = extractSurl(req.query.url || req.query.surl || 'tJBeCdKzihYl1knxJTorZQ');
  const cookie = sanitizeCookie(req.query.cookie || DEFAULT_COOKIE);
  const doFetch = getFetchClient(req.query.proxy);

  const quotaDomains = [
    'https://www.terabox.app/api/quota',
    'https://dm.1024tera.com/api/quota',
    'https://www.terabox.com/api/quota'
  ];
  const quotaResults = {};
  for (const qd of quotaDomains) {
    try {
      const qr = await doFetch(qd, { headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } });
      quotaResults[qd] = await qr.json();
    } catch (e) {
      quotaResults[qd] = { error: e.message };
    }
  }

  const testDomains = [
    `https://dm.1024tera.com/wap/share/filelist?surl=${surl}`,
    `https://www.1024tera.com/wap/share/filelist?surl=${surl}`,
    `https://dm.terabox.app/wap/share/filelist?surl=${surl}`,
    `https://www.terabox.app/wap/share/filelist?surl=${surl}`
  ];
  const wapResults = {};
  for (const wd of testDomains) {
    try {
      const wr = await doFetch(wd, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
          'Cookie': cookie
        }
      });
      const txt = await wr.text();
      const s = parseInitialState(txt);
      if (s) {
        wapResults[wd] = {
          status: wr.status,
          files: s.share?.fileList?.length || 0,
          shareid: s.share?.shareInfo?.shareid || 0,
          filename: s.share?.fileList?.[0]?.server_filename || 'none'
        };
      } else {
        wapResults[wd] = { status: wr.status, hasInitialState: false, len: txt.length, htmlSnippet: txt.slice(0, 300) };
      }
    } catch (e) {
      wapResults[wd] = { error: e.message };
    }
  }

  res.json({
    surl,
    hasCookie: Boolean(cookie),
    cookiePrefix: cookie ? cookie.slice(0, 15) + '...' : 'none',
    quotaResults,
    wapResults
  });
});

// Resolve Stream API (GET & POST)
app.all('/resolve', async (req, res) => {
  try {
    const rawUrl = req.query.url || req.query.link || req.query.surl || req.body.url || req.body.link || req.body.surl;
    if (!rawUrl) {
      return res.status(400).json({ ok: false, error: "Missing 'url' or 'surl' parameter." });
    }

    const surl = extractSurl(rawUrl);
    if (!surl) {
      return res.status(400).json({ ok: false, error: 'Could not extract valid TeraBox surl from input.' });
    }

    const isRefresh = req.query.refresh === '1' || req.body.refresh === true;
    if (!isRefresh) {
      const cached = getCached(surl);
      if (cached) {
        return res.json({ ...cached.metadata, cached: true });
      }
    }

    const workerUrl = req.query.worker || req.body.workerUrl || DEFAULT_WORKER_URL;
    const cookie = req.headers['x-terabox-cookie'] || req.query.cookie || req.body.cookie || DEFAULT_COOKIE;
    const quality = req.query.quality || req.body.quality || 'M3U8_AUTO_480';
    const proxy = req.query.proxy || req.body.proxy;

    const { metadata } = await resolveTeraBoxStream(surl, {
      cookie,
      workerUrl,
      quality,
      proxy,
      reqHost: req.get('host'),
      reqProtocol: req.protocol
    });

    res.json(metadata);
  } catch (err) {
    console.error('Resolve error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve Direct M3U8 Playlist
app.get('/playlist/:surl.m3u8', async (req, res) => {
  const surl = req.params.surl;
  const cached = getCached(surl);

  if (cached && cached.m3u8) {
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'public, max-age=14400',
      'Access-Control-Allow-Origin': '*'
    });
    return res.send(cached.m3u8);
  }

  // If not in cache, resolve on the fly
  try {
    const { m3u8 } = await resolveTeraBoxStream(surl, {
      cookie: req.query.cookie || DEFAULT_COOKIE,
      workerUrl: req.query.worker || DEFAULT_WORKER_URL,
      reqHost: req.get('host'),
      reqProtocol: req.protocol
    });

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'public, max-age=14400',
      'Access-Control-Allow-Origin': '*'
    });
    res.send(m3u8);
  } catch (err) {
    res.status(404).send(`Playlist not found: ${err.message}`);
  }
});

// Video Segment Proxy (fallback if Worker is not used)
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' parameter.");

  try {
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      'Referer': 'https://dm.terabox.app/',
      'Accept': '*/*'
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, {
      headers: upstreamHeaders
    });

    res.status(upstreamRes.status);
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Accept-Ranges': 'bytes',
      'Content-Type': upstreamRes.headers.get('content-type') || 'video/mp2t'
    });

    if (upstreamRes.headers.has('content-range')) {
      res.set('Content-Range', upstreamRes.headers.get('content-range'));
    }
    if (upstreamRes.headers.has('content-length')) {
      res.set('Content-Length', upstreamRes.headers.get('content-length'));
    }

    const buffer = await upstreamRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

// Aesthetic Interactive Dashboard & Web Tester
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeraBox Cloud Resolver & Stream Engine</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    :root {
      --bg: #090d16;
      --card: rgba(18, 24, 38, 0.85);
      --border: rgba(255, 255, 255, 0.08);
      --primary: #38bdf8;
      --accent: #818cf8;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 30px 16px;
    }
    .container { width: 100%; max-width: 900px; display: flex; flex-direction: column; gap: 24px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--primary); padding: 6px 14px; border-radius: 9999px;
      font-size: 0.8rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; }
    h1 { font-size: 2.2rem; font-weight: 800; background: linear-gradient(135deg, #fff 40%, var(--muted)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 18px; padding: 24px; backdrop-filter: blur(20px);
      box-shadow: 0 20px 40px -15px rgba(0,0,0,0.5);
    }
    .input-row { display: flex; gap: 10px; margin-top: 14px; }
    @media(max-width: 640px) { .input-row { flex-direction: column; } }
    input {
      flex: 1; background: rgba(10, 15, 28, 0.9); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px 18px; color: #fff; font-size: 0.95rem; outline: none;
    }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
    button {
      background: linear-gradient(135deg, var(--primary), var(--accent));
      color: #090d16; font-weight: 700; border: none; border-radius: 12px;
      padding: 14px 26px; cursor: pointer; transition: 0.2s; white-space: nowrap;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 10px 20px -5px rgba(56, 189, 248, 0.4); }
    #playerBox { display: none; margin-top: 20px; }
    video { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; }
    pre {
      background: #050811; border: 1px solid var(--border);
      border-radius: 12px; padding: 16px; font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem; color: #38bdf8; overflow-x: auto; max-height: 320px; margin-top: 14px;
    }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 16px; }
    .stat-card { background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
    .stat-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; font-weight: 600; }
    .stat-val { font-size: 1.1rem; font-weight: 700; margin-top: 4px; color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge"><span class="dot"></span> Online & Operational</div>
      <h1 style="margin-top: 12px;">TeraBox Cloud Resolver</h1>
      <p style="color: var(--muted); margin-top: 4px;">Ultra-fast full-length M3U8 video stream extraction (Bypasses 30s limit)</p>
    </header>

    <div class="card">
      <h3 style="font-size: 1.1rem;">⚡ Live Stream Test</h3>
      <div class="input-row">
        <input type="text" id="urlInput" placeholder="Paste TeraBox link or surl (e.g. vZU7VbstM8UT_fVepwfWkQ)" value="vZU7VbstM8UT_fVepwfWkQ">
        <button id="resolveBtn" onclick="resolveStream()">Extract & Play</button>
      </div>

      <div id="playerBox">
        <video id="videoPlayer" controls></video>
        <div class="stats-grid" id="statsGrid"></div>
        <pre id="jsonOutput"></pre>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size: 1.1rem;">📖 API Endpoints</h3>
      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 14px; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem;">
        <div><strong style="color: #34d399;">GET /health</strong> - Uptime & Service Status</div>
        <div><strong style="color: #60a5fa;">GET /resolve?url={link}&worker={workerUrl}</strong> - Resolves metadata & full M3U8</div>
        <div><strong style="color: #a78bfa;">GET /playlist/:surl.m3u8</strong> - Raw HLS playlist stream</div>
      </div>
    </div>
  </div>

  <script>
    let hlsInstance = null;
    async function resolveStream() {
      const url = document.getElementById('urlInput').value.trim();
      if (!url) return;
      const btn = document.getElementById('resolveBtn');
      btn.innerText = 'Resolving...';
      btn.disabled = true;

      try {
        const res = await fetch('/resolve?url=' + encodeURIComponent(url));
        const data = await res.json();
        
        btn.innerText = 'Extract & Play';
        btn.disabled = false;

        document.getElementById('playerBox').style.display = 'block';
        document.getElementById('jsonOutput').innerText = JSON.stringify(data, null, 2);

        if (data.ok && data.files && data.files.length > 0) {
          const file = data.files[0];
          document.getElementById('statsGrid').innerHTML = \`
            <div class="stat-card"><div class="stat-label">File</div><div class="stat-val">\${file.filename}</div></div>
            <div class="stat-card"><div class="stat-label">Duration</div><div class="stat-val" style="color: #38bdf8;">\${file.duration_formatted}</div></div>
            <div class="stat-card"><div class="stat-label">Size</div><div class="stat-val">\${file.size_formatted}</div></div>
            <div class="stat-card"><div class="stat-label">Segments</div><div class="stat-val" style="color: #10b981;">\${data.segments_count || 'Full'} Chunks</div></div>
          \`;

          const video = document.getElementById('videoPlayer');
          const streamUrl = file.m3u8_url;

          if (Hls.isSupported()) {
            if (hlsInstance) hlsInstance.destroy();
            hlsInstance = new Hls({ maxBufferLength: 30 });
            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(video);
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = streamUrl;
            video.play().catch(() => {});
          }
        }
      } catch (err) {
        alert('Resolve failed: ' + err.message);
        btn.innerText = 'Extract & Play';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`);
});

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`[TeraBox Cloud Resolver] Running on http://${HOST}:${PORT}`);
  console.log(`[TeraBox Cloud Resolver] Cloudflare Worker Target: ${DEFAULT_WORKER_URL}`);
  console.log(`[TeraBox Cloud Resolver] Cookie Configured: ${DEFAULT_COOKIE ? 'YES (Active)' : 'NO (Pass via query or env)'}`);
});
