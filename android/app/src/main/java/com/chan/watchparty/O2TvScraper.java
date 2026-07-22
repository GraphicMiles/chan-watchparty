package com.chan.watchparty;

import android.util.Log;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.FormBody;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Native O2TV Scraper - Runs on-device to bypass server IP blocking
 * 
 * Flow:
 * 1. search(query) → find shows
 * 2. getSeasons(showSlug) → list seasons
 * 3. getEpisodes(showSlug, seasonNum) → list episodes
 * 4. resolveEpisode(showName, showSlug, seasonNum, epNum) → get CDN URL
 */
public class O2TvScraper {
    private static final String TAG = "O2TvScraper";
    private static final String BASE_URL = "https://tvshows4mobile.org";
    
    private final OkHttpClient client;
    private final Map<String, String> cookieStore;
    
    public O2TvScraper() {
        this.cookieStore = new HashMap<>();
        this.client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build();
    }
    
    /**
     * Search for TV shows by name
     */
    public List<Show> search(String query) throws IOException {
        Log.d(TAG, "Searching for: " + query);
        
        String slug = queryToSlug(query);
        List<Show> results = new ArrayList<>();
        
        // Try direct show page first
        try {
            Show show = probeShowPage(slug, query);
            if (show != null) {
                results.add(show);
            }
        } catch (Exception e) {
            Log.w(TAG, "Direct probe failed: " + e.getMessage());
        }
        
        // Try catalog search
        try {
            List<Show> catalogShows = fetchCatalog();
            for (Show show : catalogShows) {
                int score = scoreMatch(query, show.name, show.slug);
                if (score > 0) {
                    show.matchScore = score;
                    // Avoid duplicates
                    boolean exists = false;
                    for (Show existing : results) {
                        if (existing.slug.equalsIgnoreCase(show.slug)) {
                            exists = true;
                            break;
                        }
                    }
                    if (!exists) {
                        results.add(show);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Catalog fetch failed: " + e.getMessage());
        }
        
        // Sort by match score
        results.sort((a, b) -> b.matchScore - a.matchScore);
        
        Log.d(TAG, "Found " + results.size() + " results");
        return results;
    }
    
    /**
     * Get seasons for a show
     */
    public List<Season> getSeasons(String showSlug) throws IOException {
        Log.d(TAG, "Fetching seasons for: " + showSlug);
        
        String url = BASE_URL + "/" + showSlug + "/";
        Document doc = fetchPage(url);
        
        List<Season> seasons = new ArrayList<>();
        Elements seasonLinks = doc.select("a[href*=\"Season-\"]");
        
        for (Element link : seasonLinks) {
            String href = link.attr("href");
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("Season-(\\d+)").matcher(href);
            if (matcher.find()) {
                int num = Integer.parseInt(matcher.group(1));
                // Avoid duplicates
                boolean exists = false;
                for (Season s : seasons) {
                    if (s.number == num) {
                        exists = true;
                        break;
                    }
                }
                if (!exists) {
                    String seasonUrl = href.startsWith("http") ? href : BASE_URL + "/" + showSlug + "/Season-" + String.format("%02d", num) + "/";
                    seasons.add(new Season(num, seasonUrl, "Season " + num));
                }
            }
        }
        
        seasons.sort((a, b) -> a.number - b.number);
        Log.d(TAG, "Found " + seasons.size() + " seasons");
        return seasons;
    }
    
    /**
     * Get episodes for a season
     */
    public List<Episode> getEpisodes(String showSlug, int seasonNum) throws IOException {
        Log.d(TAG, "Fetching episodes for " + showSlug + " S" + seasonNum);
        
        String url = BASE_URL + "/" + showSlug + "/Season-" + String.format("%02d", seasonNum) + "/";
        Document doc = fetchPage(url);
        
        List<Episode> episodes = new ArrayList<>();
        Elements episodeLinks = doc.select("a[href*=\"Episode-\"]");
        
        for (Element link : episodeLinks) {
            String href = link.attr("href");
            String text = link.text().trim();
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("Episode-(\\d+)").matcher(href);
            if (matcher.find()) {
                int num = Integer.parseInt(matcher.group(1));
                // Avoid duplicates
                boolean exists = false;
                for (Episode e : episodes) {
                    if (e.number == num) {
                        exists = true;
                        break;
                    }
                }
                if (!exists) {
                    String episodeUrl = href.startsWith("http") ? href : BASE_URL + "/" + showSlug + "/Season-" + String.format("%02d", seasonNum) + "/Episode-" + String.format("%02d", num) + "/";
                    episodes.add(new Episode(num, text.isEmpty() ? "Episode " + num : text, episodeUrl));
                }
            }
        }
        
        episodes.sort((a, b) -> a.number - b.number);
        Log.d(TAG, "Found " + episodes.size() + " episodes");
        return episodes;
    }
    
    /**
     * Resolve episode to CDN URL
     */
    public String resolveEpisode(String showName, String showSlug, int seasonNum, int epNum) throws IOException {
        Log.d(TAG, "Resolving " + showName + " S" + seasonNum + "E" + epNum);
        
        String episodePath = showSlug + "/Season-" + String.format("%02d", seasonNum) + "/Episode-" + String.format("%02d", epNum);
        String url = BASE_URL + "/" + episodePath + "/";
        Document doc = fetchPage(url);
        
        // Find download links
        Elements downloadLinks = doc.select("a[href*=\"/download/\"]");
        if (downloadLinks.isEmpty()) {
            // Try regex fallback
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("/download/(\\d+)").matcher(doc.html());
            if (matcher.find()) {
                String fileId = matcher.group(1);
                return solveCaptcha(fileId);
            }
            Log.w(TAG, "No download links found");
            return null;
        }
        
        // Try first download link
        String href = downloadLinks.first().attr("href");
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("/download/(\\d+)").matcher(href);
        if (matcher.find()) {
            String fileId = matcher.group(1);
            return solveCaptcha(fileId);
        }
        
        return null;
    }
    
    // ========== Private Helpers ==========
    
    private String queryToSlug(String query) {
        return query.toLowerCase()
            .replaceAll("[^\\w\\s-]", "")
            .replaceAll("\\s+", "-")
            .replaceAll("-+", "-")
            .replaceAll("^-|-$", "");
    }
    
    private Show probeShowPage(String slug, String query) throws IOException {
        if (slug.length() < 2) return null;
        
        String url = BASE_URL + "/" + slug + "/";
        try {
            Document doc = fetchPage(url);
            String html = doc.html();
            String finalUrl = doc.location();
            
            boolean isShowPage = html.contains("Season-") 
                && !html.contains("404 Page Not Found")
                && !finalUrl.contains("list_all_tv_series")
                && (finalUrl.toLowerCase().contains(slug.toLowerCase()) || html.toLowerCase().contains(slug.toLowerCase()));
            
            if (isShowPage) {
                String title = query;
                java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("<title>\\s*(?:Download\\s+)?(.+?)(?:\\s+TV Show|\\s*[-–|]\\s*TvShows)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
                if (matcher.find()) {
                    title = matcher.group(1).trim();
                }
                
                String actualSlug = slug;
                matcher = java.util.regex.Pattern.compile("tvshows4mobile\\.org/([^/]+)/", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(finalUrl);
                if (matcher.find()) {
                    actualSlug = matcher.group(1);
                }
                
                return new Show(title, actualSlug, title, BASE_URL + "/" + actualSlug + "/index.html", 95, true);
            }
        } catch (Exception e) {
            Log.w(TAG, "Probe failed for " + slug);
        }
        return null;
    }
    
    private List<Show> fetchCatalog() throws IOException {
        List<Show> shows = new ArrayList<>();
        String url = BASE_URL + "/search/list_all_tv_series";
        Document doc = fetchPage(url);
        
        Elements links = doc.select("a[href]");
        java.util.Set<String> seen = new java.util.HashSet<>();
        
        for (Element link : links) {
            String href = link.attr("href");
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("tvshows4mobile\\.org/([^/\"'#?]+)(?:/index\\.html)?", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(href);
            if (!matcher.find()) {
                matcher = java.util.regex.Pattern.compile("^/([^/\"'#?]+)(?:/index\\.html)?").matcher(href);
            }
            
            if (matcher.find()) {
                String slug = matcher.group(1);
                if (slug.isEmpty() || seen.contains(slug.toLowerCase())) continue;
                if (slug.matches("^(search|css|images|enable-javascript|login|register|contact|about|privacy|dmca|faq|blog|page|tag|category|wp-|assets|static|js|fonts)$")) continue;
                if (slug.matches("^download-\\d+$")) continue;
                if (slug.contains("Season-") || slug.contains("Episode-")) continue;
                
                String text = link.text().trim();
                if (text.isEmpty()) {
                    text = slug.replaceAll("-otv[a-z0-9]+$", "")
                              .replaceAll("^download-", "")
                              .replaceAll("-", " ")
                              .trim();
                }
                
                seen.add(slug.toLowerCase());
                String showUrl = href.startsWith("http") ? href : BASE_URL + "/" + slug + "/index.html";
                shows.add(new Show(text, slug, text, showUrl, 0, false));
            }
        }
        
        return shows;
    }
    
    private int scoreMatch(String query, String showName, String showSlug) {
        String qNorm = normalize(query);
        String tNorm = normalize(showName);
        String sNorm = normalize(showSlug.replaceAll("^download-", "")
                                          .replaceAll("-otv[a-z0-9]+$", "")
                                          .replaceAll("-\\d+$", "")
                                          .replaceAll("-", " "));
        
        if (qNorm.isEmpty()) return 0;
        if (tNorm.equals(qNorm) || sNorm.equals(qNorm)) return 100;
        
        String[] qWords = stripArticles(toWords(query));
        String[] tWords = stripArticles(toWords(showName));
        String[] sWords = stripArticles(toWords(showSlug.replaceAll("^download-", "")
                                                        .replaceAll("-otv[a-z0-9]+$", "")
                                                        .replaceAll("-\\d+$", "")
                                                        .replaceAll("-", " ")));
        
        String qJoined = String.join(" ", qWords);
        String tJoined = String.join(" ", tWords);
        String sJoined = String.join(" ", sWords);
        
        if (!qJoined.isEmpty() && (qJoined.equals(tJoined) || qJoined.equals(sJoined))) return 98;
        if (!qJoined.isEmpty() && (tJoined.startsWith(qJoined) || sJoined.startsWith(qJoined))) return 95;
        if (tNorm.startsWith(qNorm) || sNorm.startsWith(qNorm)) return 90;
        if (tNorm.contains(qNorm) || sNorm.contains(qNorm)) return 80;
        
        String[] tokens = qNorm.split("[^a-z0-9]+");
        if (tokens.length >= 1) {
            String hay = tNorm + sNorm;
            boolean allMatch = true;
            for (String token : tokens) {
                if (token.length() >= 3 && !hay.contains(token)) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch && tokens.length > 0) return 60;
        }
        
        return 0;
    }
    
    private String normalize(String str) {
        return str.toLowerCase().replaceAll("[^a-z0-9]", "").trim();
    }
    
    private String[] toWords(String s) {
        return s.toLowerCase().replaceAll("[^a-z0-9\\s]", " ").trim().split("\\s+");
    }
    
    private String[] stripArticles(String[] words) {
        if (words.length > 1 && (words[0].equals("the") || words[0].equals("a") || words[0].equals("an"))) {
            String[] result = new String[words.length - 1];
            System.arraycopy(words, 1, result, 0, result.length);
            return result;
        }
        return words;
    }
    
    private Document fetchPage(String url) throws IOException {
        Request request = new Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.5")
            .header("Accept-Encoding", "gzip, deflate, br")
            .header("Connection", "keep-alive")
            .header("Upgrade-Insecure-Requests", "1")
            .build();
        
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("HTTP " + response.code());
            }
            
            // Store cookies
            List<String> cookies = response.headers("Set-Cookie");
            for (String cookie : cookies) {
                String[] parts = cookie.split(";")[0].split("=", 2);
                if (parts.length == 2) {
                    cookieStore.put(parts[0].trim(), parts[1].trim());
                }
            }
            
            return Jsoup.parse(response.body().string());
        }
    }
    
    private String solveCaptcha(String fileId) throws IOException {
        Log.d(TAG, "Solving captcha for file " + fileId);
        
        // Get captcha page
        String captchaUrl = BASE_URL + "/areyouhuman.php?fid=" + fileId;
        Document captchaDoc = fetchPage(captchaUrl);
        String html = captchaDoc.html();
        
        // Extract session cookie
        String sessionCookie = "";
        List<String> cookies = client.cookieJar().loadForRequest(
            okhttp3.HttpUrl.parse(captchaUrl)
        );
        for (String cookie : cookies) {
            if (cookie.contains("ci_session")) {
                sessionCookie = cookie;
                break;
            }
        }
        
        // Extract captcha image
        java.util.regex.Matcher imgMatcher = java.util.regex.Pattern.compile("simple-php-captcha\\.php\\?_CAPTCHA[^\"'\\s]*", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
        if (!imgMatcher.find()) {
            Log.e(TAG, "No captcha image found");
            return null;
        }
        
        String captchaImgPath = imgMatcher.group().replaceAll("&amp;", "&");
        String captchaImgUrl = BASE_URL + "/" + captchaImgPath;
        Log.d(TAG, "Captcha image: " + captchaImgUrl);
        
        // Download captcha image
        byte[] imgBytes = downloadBytes(captchaImgUrl, sessionCookie);
        String imgBase64 = android.util.Base64.encodeToString(imgBytes, android.util.Base64.NO_WRAP);
        
        // Send to Groq Vision API
        String groqKey = BuildConfig.GROQ_API_KEY;
        if (groqKey == null || groqKey.isEmpty()) {
            Log.e(TAG, "GROQ_API_KEY not configured");
            return null;
        }
        
        String captchaText = solveWithGroq(imgBase64, groqKey);
        if (captchaText == null || captchaText.length() < 2) {
            Log.e(TAG, "Groq returned invalid text");
            return null;
        }
        
        Log.d(TAG, "Groq read: " + captchaText);
        
        // Submit captcha
        String submitUrl = BASE_URL + "/areyouhuman.php?fid=" + fileId;
        RequestBody formBody = new FormBody.Builder()
            .add("captchainput", captchaText)
            .add("submit", "Continue Download")
            .build();
        
        Request submitRequest = new Request.Builder()
            .url(submitUrl)
            .post(formBody)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Cookie", sessionCookie)
            .header("Referer", captchaUrl)
            .build();
        
        try (Response response = client.newCall(submitRequest).execute()) {
            if (!response.isSuccessful()) {
                Log.e(TAG, "Captcha submit failed: HTTP " + response.code());
                return null;
            }
            
            // Check for redirect to CDN
            String location = response.header("Location");
            if (location != null && (location.contains("o2tv.org") || location.contains(".mp4"))) {
                Log.d(TAG, "CDN redirect: " + location);
                return location;
            }
            
            // Check response body for CDN URL
            String responseBody = response.body().string();
            java.util.regex.Matcher urlMatcher = java.util.regex.Pattern.compile("https?://[^\"'\\s<>)]+\\.mp4[^\"'\\s<>)]*", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(responseBody);
            if (urlMatcher.find()) {
                String cdnUrl = urlMatcher.group().replaceAll("&amp;", "&");
                Log.d(TAG, "CDN URL from body: " + cdnUrl);
                return cdnUrl;
            }
            
            // Check if captcha was wrong
            if (responseBody.contains("Captcha Does Not Match")) {
                Log.w(TAG, "Wrong captcha text, retrying...");
                return solveCaptcha(fileId); // Retry once
            }
        }
        
        return null;
    }
    
    private byte[] downloadBytes(String url, String cookie) throws IOException {
        Request request = new Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Cookie", cookie)
            .build();
        
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("Download failed: HTTP " + response.code());
            }
            return response.body().bytes();
        }
    }
    
    private String solveWithGroq(String imgBase64, String apiKey) throws IOException {
        String jsonBody = "{\n" +
            "  \"model\": \"meta-llama/llama-4-scout-17b-16e-instruct\",\n" +
            "  \"messages\": [{\n" +
            "    \"role\": \"user\",\n" +
            "    \"content\": [{\n" +
            "      \"type\": \"text\",\n" +
            "      \"text\": \"Read the text shown in this CAPTCHA image. Reply with ONLY the text characters, nothing else.\"\n" +
            "    }, {\n" +
            "      \"type\": \"image_url\",\n" +
            "      \"image_url\": {\"url\": \"data:image/png;base64," + imgBase64 + "\"}\n" +
            "    }]\n" +
            "  }],\n" +
            "  \"max_tokens\": 20,\n" +
            "  \"temperature\": 0\n" +
            "}";
        
        Request request = new Request.Builder()
            .url("https://api.groq.com/openai/v1/chat/completions")
            .post(RequestBody.create(jsonBody, MediaType.parse("application/json")))
            .header("Authorization", "Bearer " + apiKey)
            .header("Content-Type", "application/json")
            .build();
        
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                Log.e(TAG, "Groq API failed: HTTP " + response.code());
                return null;
            }
            
            String responseBody = response.body().string();
            // Parse JSON response (simple regex for quick extraction)
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\"content\"\\s*:\\s*\"([^\"]+)\"").matcher(responseBody);
            if (matcher.find()) {
                return matcher.group(1).trim();
            }
        }
        
        return null;
    }
    
    // ========== Data Models ==========
    
    public static class Show {
        public String title;
        public String slug;
        public String name;
        public String url;
        public int matchScore;
        public boolean guessed;
        
        public Show(String title, String slug, String name, String url, int matchScore, boolean guessed) {
            this.title = title;
            this.slug = slug;
            this.name = name;
            this.url = url;
            this.matchScore = matchScore;
            this.guessed = guessed;
        }
    }
    
    public static class Season {
        public int number;
        public String url;
        public String label;
        
        public Season(int number, String url, String label) {
            this.number = number;
            this.url = url;
            this.label = label;
        }
    }
    
    public static class Episode {
        public int number;
        public String title;
        public String url;
        
        public Episode(int number, String title, String url) {
            this.number = number;
            this.title = title;
            this.url = url;
        }
    }
}
