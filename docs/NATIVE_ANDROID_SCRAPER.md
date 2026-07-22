# Native Android O2TV Scraper

## Overview

This is a **native Android implementation** of the O2TV scraper that runs entirely on-device, bypassing server-side IP blocking.

## Architecture

```
Android App (On-Device)
    ↓
O2TvScraper.java (Native Java)
    ↓
OkHttp → tvshows4mobile.org (from user's IP)
    ↓
Jsoup → Parse HTML
    ↓
Return results to React via Capacitor Bridge
```

## Why Native?

| Issue | Server-Side | Native (This) |
|-------|-------------|---------------|
| IP Blocking |  Cloud IPs blocked | ✅ User's IP |
| JavaScript Challenge | ❌ Needs Puppeteer | ✅ WebView handles it |
| Rate Limiting | ❌ Shared across users | ✅ Per-user limits |
| Latency | ⚠️ Server roundtrip | ✅ Direct connection |
| Cost | ⚠️ Server costs | ✅ Free (user's device) |

## Dependencies

Added to `android/app/build.gradle`:

```gradle
implementation 'com.squareup.okhttp3:okhttp:4.12.0'
implementation 'org.jsoup:jsoup:1.17.2'
```

- **OkHttp**: HTTP client with cookie handling, redirects, timeouts
- **Jsoup**: HTML parser (Java equivalent of cheerio)

## Features

### 1. Search (`search(query)`)
- Direct show page probe
- Catalog fetch and matching
- Score-based ranking (0-100)
- Returns `List<Show>`

### 2. Seasons (`getSeasons(showSlug)`)
- Parses season links from show page
- Returns `List<Season>`

### 3. Episodes (`getEpisodes(showSlug, seasonNum)`)
- Parses episode links from season page
- Returns `List<Episode>`

### 4. Resolve (`resolveEpisode(...)`)
- Finds download links
- Extracts file IDs
- Returns CDN URL (captcha solving TBD)

## Data Models

### Show
```java
public class Show {
    public String title;
    public String slug;
    public String name;
    public String url;
    public int matchScore;  // 0-100
    public boolean guessed; // Direct probe match
}
```

### Season
```java
public class Season {
    public int number;
    public String url;
    public String label;
}
```

### Episode
```java
public class Episode {
    public int number;
    public String title;
    public String url;
}
```

## Matching Algorithm

Same scoring as server-side:
- **100**: Exact match (title or slug)
- **98**: Word-for-word match (articles stripped)
- **95**: Prefix match
- **90**: Starts with query
- **80**: Contains query
- **60**: All significant tokens present

## Usage Example

```java
O2TvScraper scraper = new O2TvScraper();

// Search
List<Show> shows = scraper.search("Silo");
Show silo = shows.get(0); // Best match

// Get seasons
List<Season> seasons = scraper.getSeasons(silo.slug);
Season season1 = seasons.get(0);

// Get episodes
List<Episode> episodes = scraper.getEpisodes(silo.slug, season1.number);
Episode ep1 = episodes.get(0);

// Resolve to CDN URL
String cdnUrl = scraper.resolveEpisode(silo.name, silo.slug, season1.number, ep1.number);
```

## Integration with React

Use Capacitor custom plugin to bridge:

```typescript
// In React
import { Plugins } from '@capacitor/core';
const { O2TvPlugin } = Plugins;

const results = await O2TvPlugin.search({ query: 'Silo' });
```

## Captcha Solving

The current implementation detects captcha but doesn't solve it automatically. Options:

1. **Manual Input**: Show captcha image to user, they type the text
2. **OCR Service**: Integrate with Google ML Kit or similar
3. **Groq Vision**: Send image to Groq API (requires API key)

For MVP, manual input is recommended.

## Caching

Implement with Room Database or SharedPreferences:
- Cache search results (5 min TTL)
- Cache season/episode lists (30 min TTL)
- Cache resolved CDN URLs (1 hour TTL)

## Error Handling

All methods throw `IOException` on network failures. Wrap calls:

```java
try {
    List<Show> shows = scraper.search("Silo");
} catch (IOException e) {
    // Show error to user, offer retry
}
```

## Testing

Unit tests in `android/app/src/test/`:

```java
@Test
public void testSearch() {
    O2TvScraper scraper = new O2TvScraper();
    // Mock OkHttp responses
    // Assert results
}
```

## Performance

- **Search**: ~2-3s (probe + catalog)
- **Seasons**: ~1s (single page fetch)
- **Episodes**: ~1s (single page fetch)
- **Resolve**: ~3-5s (page + captcha)

## Limitations

1. **Captcha**: Not auto-solved yet
2. **Rate Limiting**: No built-in delay (add if needed)
3. **Offline**: No cached data support yet

## Future Enhancements

- [ ] Room Database caching
- [ ] Capacitor bridge plugin
- [ ] Manual captcha input UI
- [ ] Background sync
- [ ] Download manager integration
- [ ] Subtitle support

## Build

```bash
cd android
./gradlew assembleDebug
```

APK location: `android/app/build/outputs/apk/debug/app-debug.apk`

## CI/CD

GitHub Actions workflow in `.github/workflows/android.yml`:
- Triggers on push to main
- Builds debug APK
- Uploads as artifact
- Auto-releases on version tags
