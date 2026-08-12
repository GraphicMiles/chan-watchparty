package com.chan.watchparty.nativeplayer.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Minimal Firestore REST client — talks directly to the Firestore REST API
 * with the user's Firebase ID token. No google-services.json, no Firebase SDK.
 *
 * All methods return parsed document maps: field path → parsed value
 * (String / Long / Double / Boolean / Long-epoch-ms for timestamps).
 */
class FirestoreClient(
    private val projectId: String,
    private val apiKey: String,
    private val idToken: () -> String,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val base: String
        get() = "https://firestore.googleapis.com/v1/projects/$projectId/databases/(default)/documents"

    private fun request(url: String): Request.Builder =
        Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${idToken()}")
            .header("Accept", "application/json")

    private fun handle(response: okhttp3.Response): String? {
        if (!response.isSuccessful) {
            val body = response.body?.string().orEmpty()
            if (response.code == 404 && body.contains("NOT_FOUND")) return null
            throw RuntimeException("Firestore HTTP ${response.code}: ${body.take(300)}")
        }
        return response.body?.string()
    }

    // ── Reads ───────────────────────────────────────────────────────────

    /** Returns the document as a field map, or null when it doesn't exist. */
    fun getDocument(path: String): Map<String, Any?>? {
        val url = "$base/$path?key=$apiKey"
        val res = client.newCall(request(url).get().build()).execute()
        val body = handle(res) ?: return null
        val doc = JSONObject(body)
        if (!doc.has("fields")) return emptyMap()
        return parseFields(doc.getJSONObject("fields"))
    }

    /** List documents in a collection (path relative to documents root). */
    fun listDocuments(
        path: String,
        orderBy: String? = null,
        direction: String = "asc",
        pageSize: Int = 200,
    ): List<Pair<String, Map<String, Any?>>> {
        val sb = StringBuilder("$base/$path?key=$apiKey&pageSize=$pageSize")
        if (orderBy != null) {
            sb.append("&orderBy=").append(java.net.URLEncoder.encode("\"$orderBy\" $direction", "UTF-8"))
        }
        val res = client.newCall(request(sb.toString()).get().build()).execute()
        val body = handle(res) ?: return emptyList()
        val obj = JSONObject(body)
        if (!obj.has("documents")) return emptyList()
        val arr = obj.getJSONArray("documents")
        val out = ArrayList<Pair<String, Map<String, Any?>>>()
        for (i in 0 until arr.length()) {
            val doc = arr.getJSONObject(i)
            val name = doc.optString("name", "")
            val id = name.substringAfterLast('/')
            out.add(id to parseFields(doc.optJSONObject("fields") ?: JSONObject()))
        }
        return out
    }

    // ── Writes ──────────────────────────────────────────────────────────

    /** Upsert a document (create or update) with optional server-time fields. */
    fun setDocument(
        path: String,
        fields: Map<String, Any?>,
        serverTimestampPaths: List<String> = emptyList(),
        createOnly: Boolean = false,
    ) {
        commit(listOf(updateWrite(path, fields, serverTimestampPaths, createOnly)))
    }

    fun deleteDocument(path: String) {
        commit(listOf(JSONObject().put("delete", "$base/$path")))
    }

    fun batchDelete(paths: List<String>) {
        if (paths.isEmpty()) return
        commit(paths.map { JSONObject().put("delete", "$base/$it") })
    }

    fun commit(writes: List<JSONObject>) {
        val payload = JSONObject().put("writes", JSONArray(writes))
        val body = payload.toString().toRequestBody(jsonMedia)
        val url = "https://firestore.googleapis.com/v1/projects/$projectId/databases/(default)/documents:commit?key=$apiKey"
        val res = client.newCall(request(url).post(body).build()).execute()
        handle(res)
    }

    private fun updateWrite(
        path: String,
        fields: Map<String, Any?>,
        serverTimestampPaths: List<String>,
        createOnly: Boolean,
    ): JSONObject {
        val update = JSONObject()
        update.put("name", "$base/$path")
        update.put("fields", toFields(fields))
        val maskPaths = fields.keys + serverTimestampPaths
        update.put("updateMask", JSONObject().put("fieldPaths", JSONArray(maskPaths.toList())))
        if (serverTimestampPaths.isNotEmpty()) {
            val transforms = JSONArray()
            for (p in serverTimestampPaths) {
                transforms.put(
                    JSONObject()
                        .put("fieldPath", p)
                        .put("setToServerValue", "REQUEST_TIME")
                )
            }
            update.put("transforms", transforms)
        }
        if (createOnly) {
            update.put("currentDocument", JSONObject().put("exists", false))
        }
        return JSONObject().put("update", update)
    }

    // ── Field encoding / decoding ───────────────────────────────────────

    fun toFields(map: Map<String, Any?>): JSONObject {
        val out = JSONObject()
        for ((k, v) in map) {
            when (v) {
                is String -> out.put(k, JSONObject().put("stringValue", v))
                is Long -> out.put(k, JSONObject().put("integerValue", v.toString()))
                is Int -> out.put(k, JSONObject().put("integerValue", v.toString()))
                is Boolean -> out.put(k, JSONObject().put("booleanValue", v))
                is Double -> out.put(k, JSONObject().put("doubleValue", v))
                is Map<*, *> -> out.put(k, JSONObject().put("mapValue", JSONObject().put("fields", toFields(v as Map<String, Any?>))))
                else -> out.put(k, JSONObject().put("nullValue", JSONObject.NULL))
            }
        }
        return out
    }

    fun parseFields(fields: JSONObject): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        val keys = fields.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            out[key] = parseValue(fields.getJSONObject(key))
        }
        return out
    }

    private fun parseValue(v: JSONObject): Any? {
        if (v.has("stringValue")) return v.getString("stringValue")
        if (v.has("integerValue")) return v.getString("integerValue").toLong()
        if (v.has("doubleValue")) return v.getDouble("doubleValue")
        if (v.has("booleanValue")) return v.getBoolean("booleanValue")
        if (v.has("timestampValue")) return parseTimestampMs(v.getString("timestampValue"))
        if (v.has("nullValue")) return null
        if (v.has("arrayValue")) {
            val arr = v.getJSONObject("arrayValue").optJSONArray("values") ?: JSONArray()
            return (0 until arr.length()).map { parseValue(arr.getJSONObject(it)) }
        }
        if (v.has("mapValue")) {
            val fields = v.getJSONObject("mapValue").optJSONObject("fields") ?: JSONObject()
            return parseFields(fields)
        }
        return null
    }

    companion object {
        /** Parse an RFC3339 Firestore timestamp to epoch millis. */
        fun parseTimestampMs(ts: String): Long {
            return try {
                val cleaned = if (ts.endsWith("Z")) ts.dropLast(1) else ts
                val dot = cleaned.indexOf('.')
                val base = if (dot >= 0) cleaned.substring(0, dot) else cleaned
                val frac = if (dot >= 0) cleaned.substring(dot + 1).take(3).padEnd(3, '0') else "000"
                val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
                fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
                fmt.parse(base).time + frac.toLong()
            } catch (_: Exception) {
                0L
            }
        }
    }
}
