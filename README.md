# ⚡ TeraBox Cloud Stream Resolver & Full M3U8 Engine

A 100% automated, high-performance cloud micro-service that extracts **genuine full-length HLS (M3U8) streaming playlists** from TeraBox public links—completely bypassing the 30-second preview cutoff.

Designed to seamlessly pair with **Cloudflare Workers** for unlimited bandwidth video proxying, zero buffering, and 24/7 cloud execution without keeping your personal laptop turned on.

---

## 🌟 Key Features

- **No 30-Second Limit**: Extracts genuine server-signed HLS streams with full duration (tested on 2h 37m movies, 35m episodes, anime).
- **Zero Bandwidth Bills**: Rewrites `.ts` video chunks to route through your free Cloudflare Worker global CDN proxy.
- **Dual Cloud Caching**: Instant sub-10ms responses using in-memory LRU cache and automatic sync with Cloudflare KV (`/api/cache-stream`).
- **Free 24/7 Cloud Hosting**: Deployable in 1 click on **Render.com** (Free Web Service), **Hugging Face Spaces**, **Koyeb**, or **Railway**.
- **Interactive Web UI**: Built-in test console with HLS.js player, video stats, and instant stream testing.
- **Cross-Player Compatible**: Stream links play smoothly in VLC Player, PotPlayer, IINA, Safari, iOS, Android, and web browsers.

---

## 🏗️ 2-Tier Architecture

```
┌─────────────────┐       GET /resolve?surl=...        ┌──────────────────────────────┐
│  Web Player /   │ ─────────────────────────────────> │  TeraBox Cloud Resolver      │
│  Client Device  │                                    │  (Render.com / Hugging Face) │
└─────────────────┘                                    └──────────────┬───────────────┘
         │                                                            │
         │                                       1. Fetches WAP metadata & full HLS
         │                                       2. Rewrites chunks to Worker proxy
         │                                       3. Pushes to Cloudflare KV
         │                                                            │
         ▼                                                            ▼
┌─────────────────────────────────┐                    ┌──────────────────────────────┐
│ Cloudflare Worker Proxy         │ <───────────────── │  TeraBox WAP & Video CDN     │
│ (Streams .ts chunks with Range) │                    │  (Origin Video Chunks)       │
└─────────────────────────────────┘                    └──────────────────────────────┘
```

1. **Resolver Layer (This Service on Render / Hugging Face)**:
   - Makes lightweight (~0.3s) API calls to extract genuine tokens (`sign`, `timestamp`, `randsk`, `fid`).
   - Generates the complete M3U8 playlist with 100% of video chunks.
   - Pushes the playlist to Cloudflare Worker KV cache.
2. **Delivery Layer (Cloudflare Worker)**:
   - Serves the cached M3U8 playlist directly.
   - Proxies the heavy binary `.ts` chunks with HTTP 206 Partial Content (zero bandwidth bills, unlimited users).

---

## 🚀 1-Click Free Deployment (Render.com)

Render provides a 100% free web service tier that stays live in the cloud without requiring a credit card or laptop.

### Step 1: Connect GitHub Repository
1. Go to [Render Dashboard](https://dashboard.render.com/) and log in.
2. Click **New +** -> **Web Service**.
3. Select **Build and deploy from a Git repository**.
4. Choose `aaghazafzal/terabox`.

### Step 2: Configure Settings
- **Name**: `terabox-resolver` (or any name you prefer)
- **Region**: Oregon (US West) or Frankfurt
- **Branch**: `main`
- **Runtime**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Instance Type**: `Free`

### Step 3: Add Environment Variables
Under the **Environment Variables** section, add:
| Key | Value | Description |
|---|---|---|
| `TERABOX_COOKIE` | `ndus=YOUR_COOKIE_HERE; lang=en; PANWEB=1` | Your TeraBox account cookie |
| `WORKER_URL` | `https://terabox-player-api.cinemahubapi.workers.dev` | Your Cloudflare Worker URL |
| `PORT` | `10000` | (Default port assigned by Render) |

Click **Create Web Service**. Your service will be live in 1-2 minutes with a free URL like:
`https://terabox-resolver.onrender.com`

---

## 🔑 How to Get Your TeraBox `ndus` Cookie

1. Open your browser and go to [terabox.com](https://www.terabox.com) (make sure you are logged into your account).
2. Press `F12` (or Right-Click -> **Inspect**) to open Developer Tools.
3. Go to the **Application** tab (on Firefox/Safari: **Storage** tab).
4. In the left sidebar, expand **Cookies** and click on `https://www.terabox.com`.
5. Find the row named `ndus`, double-click its value, and copy it.
6. Set your environment variable:
   ```
   TERABOX_COOKIE="ndus=YOUR_COPIED_VALUE; lang=en; PANWEB=1"
   ```

*(Note: Video streaming consumes zero cookie quota; cookies are only accessed for ~0.3s during the initial playlist generation).*

---

## 📡 API Reference

### 1. Health Check
```http
GET /health
```
**Response:**
```json
{
  "status": "ok",
  "uptime": 1245,
  "timestamp": "2026-10-19T18:30:00.000Z",
  "workerUrl": "https://terabox-player-api.cinemahubapi.workers.dev",
  "hasDefaultCookie": true
}
```

### 2. Resolve Full-Length Video Stream
```http
GET /resolve?url={TERABOX_URL_OR_SURL}
```
**Example:**
```http
GET /resolve?url=https://terabox.app/s/1vZU7VbstM8UT_fVepwfWkQ
```
**Response:**
```json
{
  "ok": true,
  "mode": "full_hls_stream",
  "surl": "vZU7VbstM8UT_fVepwfWkQ",
  "total_files": 1,
  "share_title": "Episode 0001.mp4",
  "segments_count": 947,
  "files": [
    {
      "fs_id": "4399870449913",
      "filename": "Episode 0001.mp4",
      "size_bytes": 304087040,
      "size_formatted": "290.00 MB",
      "duration_seconds": 9439,
      "duration_formatted": "02:37:19",
      "category": "1",
      "thumbnail": "https://dm-data.1024terabox.com/thumbnail/...",
      "m3u8_url": "https://terabox-player-api.cinemahubapi.workers.dev/playlist/vZU7VbstM8UT_fVepwfWkQ.m3u8",
      "stream_url": "https://terabox-player-api.cinemahubapi.workers.dev/playlist/vZU7VbstM8UT_fVepwfWkQ.m3u8"
    }
  ]
}
```

### 3. Direct M3U8 Playlist Stream
```http
GET /playlist/:surl.m3u8
```
Directly outputs the HLS playlist formatted with CORS headers for any external video player or IPTV app.

---

## 💻 Local Development

```bash
# Clone the repository
git clone git@github.com-aaghazafzal:aaghazafzal/terabox.git
cd terabox

# Install dependencies
npm install

# Copy environment file and add your credentials
cp .env.example .env

# Start development server
npm start
```

Open `http://localhost:3000` in your browser to access the Web UI.

---

## 🛡️ License

MIT License. Created by [aaghazafzal](https://github.com/aaghazafzal).
