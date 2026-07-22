package com.chan.watchparty;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import java.io.IOException;
import java.util.List;

@CapacitorPlugin(name = "O2TvPlugin")
public class O2TvPlugin extends Plugin {
    private static final String TAG = "O2TvPlugin";
    private O2TvScraper scraper;
    
    @Override
    public void load() {
        scraper = new O2TvScraper();
    }
    
    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.isEmpty()) {
            call.reject("Query is required");
            return;
        }
        
        new Thread(() -> {
            try {
                List<O2TvScraper.Show> shows = scraper.search(query);
                JSObject result = new JSObject();
                JSONArray showsArray = new JSONArray();
                
                for (O2TvScraper.Show show : shows) {
                    JSObject showObj = new JSObject();
                    showObj.put("title", show.title);
                    showObj.put("slug", show.slug);
                    showObj.put("name", show.name);
                    showObj.put("url", show.url);
                    showObj.put("matchScore", show.matchScore);
                    showObj.put("guessed", show.guessed);
                    showsArray.put(showObj);
                }
                
                result.put("shows", showsArray);
                call.resolve(result);
            } catch (IOException e) {
                Log.e(TAG, "Search failed", e);
                call.reject("Search failed: " + e.getMessage());
            }
        }).start();
    }
    
    @PluginMethod
    public void getSeasons(PluginCall call) {
        String showSlug = call.getString("showSlug");
        if (showSlug == null || showSlug.isEmpty()) {
            call.reject("showSlug is required");
            return;
        }
        
        new Thread(() -> {
            try {
                List<O2TvScraper.Season> seasons = scraper.getSeasons(showSlug);
                JSObject result = new JSObject();
                JSONArray seasonsArray = new JSONArray();
                
                for (O2TvScraper.Season season : seasons) {
                    JSObject seasonObj = new JSObject();
                    seasonObj.put("number", season.number);
                    seasonObj.put("url", season.url);
                    seasonObj.put("label", season.label);
                    seasonsArray.put(seasonObj);
                }
                
                result.put("seasons", seasonsArray);
                call.resolve(result);
            } catch (IOException e) {
                Log.e(TAG, "Get seasons failed", e);
                call.reject("Get seasons failed: " + e.getMessage());
            }
        }).start();
    }
    
    @PluginMethod
    public void getEpisodes(PluginCall call) {
        String showSlug = call.getString("showSlug");
        Integer seasonNum = call.getInt("seasonNum");
        
        if (showSlug == null || showSlug.isEmpty() || seasonNum == null) {
            call.reject("showSlug and seasonNum are required");
            return;
        }
        
        new Thread(() -> {
            try {
                List<O2TvScraper.Episode> episodes = scraper.getEpisodes(showSlug, seasonNum);
                JSObject result = new JSObject();
                JSONArray episodesArray = new JSONArray();
                
                for (O2TvScraper.Episode episode : episodes) {
                    JSObject episodeObj = new JSObject();
                    episodeObj.put("number", episode.number);
                    episodeObj.put("title", episode.title);
                    episodeObj.put("url", episode.url);
                    episodesArray.put(episodeObj);
                }
                
                result.put("episodes", episodesArray);
                call.resolve(result);
            } catch (IOException e) {
                Log.e(TAG, "Get episodes failed", e);
                call.reject("Get episodes failed: " + e.getMessage());
            }
        }).start();
    }
    
    @PluginMethod
    public void resolveEpisode(PluginCall call) {
        String showName = call.getString("showName");
        String showSlug = call.getString("showSlug");
        Integer seasonNum = call.getInt("seasonNum");
        Integer epNum = call.getInt("epNum");
        
        if (showName == null || showSlug == null || seasonNum == null || epNum == null) {
            call.reject("All parameters are required");
            return;
        }
        
        new Thread(() -> {
            try {
                String cdnUrl = scraper.resolveEpisode(showName, showSlug, seasonNum, epNum);
                JSObject result = new JSObject();
                result.put("url", cdnUrl);
                call.resolve(result);
            } catch (IOException e) {
                Log.e(TAG, "Resolve episode failed", e);
                call.reject("Resolve episode failed: " + e.getMessage());
            }
        }).start();
    }
}
