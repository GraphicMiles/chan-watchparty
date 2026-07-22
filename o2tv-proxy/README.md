# O2TV Proxy Server

Proxy service for tvshows4mobile.org to avoid IP blocking and manage requests.

## Features

- **Browser Headers**: Adds Chrome 120 headers to avoid detection
- **Response Caching**: 5-minute TTL cache reduces load
- **Rate Limiting**: 60 requests/minute per IP
- **Health Monitoring**: `/health` and `/stats` endpoints
- **Cache Management**: `/clear-cache` endpoint

## Deployment

### Option 1: Render (Recommended)

1. Create new Web Service on Render
2. Connect this repo
3. Set:
   - **Root Directory**: `o2tv-proxy`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Deploy

You'll get a URL like: `https://o2tv-proxy-xxxx.onrender.com`

### Option 2: Local Development

```bash
cd o2tv-proxy
npm install
npm run dev
```

Server runs on `http://localhost:3001`

## API

### GET /proxy?url={path}

Proxy a request to tvshows4mobile.org

**Parameters:**
- `url` - Path or full URL to proxy

**Example:**
```
GET /proxy?url=/search/list_all_tv_series
GET /proxy?url=https://tvshows4mobile.org/Silo/index.html
```

**Response:**
```json
{
  "url": "https://tvshows4mobile.org/...",
  "status": 200,
  "contentType": "text/html",
  "data": "<!DOCTYPE html>...",
  "isBinary": false
}
```

### GET /health

Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "cacheSize": 42,
  "rateLimits": 5
}
```

### GET /stats

Detailed statistics

**Response:**
```json
{
  "cacheSize": 42,
  "activeClients": 3,
  "rateLimits": [
    { "ip": "1.2.3.4", "count": 15 }
  ]
}
```

### POST /clear-cache

Clear the response cache

**Response:**
```json
{ "message": "Cache cleared" }
```

## Integration with Main App

Update `server-lib/o2tvResolver.js` to use the proxy:

```javascript
const PROXY_URL = process.env.O2TV_PROXY_URL || 'https://o2tv-proxy-xxxx.onrender.com'

async function fetchPage(url, timeoutMs = 8000) {
  // Use proxy for tvshows4mobile.org requests
  if (url.includes('tvshows4mobile.org')) {
    const proxyUrl = `${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`
    const res = await fetch(proxyUrl, { signal: controller.signal })
    const result = await res.json()

    if (result.status !== 200) {
      throw new Error(`HTTP ${result.status}`)
    }

    return result.isBinary
      ? Buffer.from(result.data, 'base64')
      : result.data
  }

  // Direct fetch for other URLs
  // ... existing code
}
```

## Environment Variables

- `PORT` - Server port (default: 3001)
- `O2TV_PROXY_URL` - Proxy URL for main app integration

## Monitoring

Check the logs on Render dashboard for:
- `[Proxy] Fetching:` - Requests being made
- `[Proxy] Success:` - Successful responses
- `[Proxy] Cache hit:` - Cache hits
- `[Proxy] Error:` - Errors

## Troubleshooting

### 403 Errors
If you still get 403 errors:
1. Check if the proxy IP is also blocked
2. Deploy to a different region/service
3. Consider using a rotating proxy service

### Rate Limiting
If you hit rate limits:
- Increase `RATE_LIMIT_MAX` in server.js
- Deploy multiple proxy instances
- Use a load balancer

### Cache Issues
If you need fresh data:
- POST to `/clear-cache`
- Reduce `CACHE_TTL` in server.js
