package com.chan.watchparty.nativeplayer.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class RoomData(
    val title: String = "",
    val hostId: String = "",
    val hostName: String = "",
    val coHosts: List<String> = emptyList(),
    val capacity: Int = 12,
    val participantCount: Int = 0,
    val status: String = "live",
    val isLive: Boolean = false,
    val locked: Boolean = false,
    val isPrivate: Boolean = false,
    val inviteCode: String = "",
    val videoUrl: String? = null,
    val videoType: String = "direct",
    val thumbnail: String? = null,
    val vibeLighting: Boolean = false,
    /** Stream descriptor { streamUrl (absolute), referer, headers, container, codec }. */
    val media: Map<String, Any?> = emptyMap(),
) {
    /**
     * Absolute URL for native playback:
     *   1. media.streamUrl (absolute CDN) — the ideal direct source.
     *   2. videoUrl when it is already absolute.
     *   3. apiBase + videoUrl when videoUrl is a relative /api/proxy path
     *      (the web API origin serves the stream with Range support, so the
     *      native engines can open it directly).
     */
    val playableUrl: String?
        get() {
            val stream = media["streamUrl"] as? String
            if (!stream.isNullOrBlank() && (stream.startsWith("http://") || stream.startsWith("https://"))) {
                return stream
            }
            val v = videoUrl ?: return null
            if (v.startsWith("http://") || v.startsWith("https://")) return v
            if (v.startsWith("/api/")) {
                val base = apiBase.trimEnd('/')
                return if (base.isNotEmpty()) base + v else null
            }
            return null
        }
}

data class ChatMessage(
    val id: String,
    val uid: String,
    val displayName: String,
    val text: String,
    val type: String = "user",
    val createdAtMs: Long = 0L,
    val replyTo: Map<String, Any?>? = null,
)

data class QueueItem(
    val id: String,
    val title: String,
    val videoUrl: String? = null,
    val videoId: String? = null,
    val videoType: String = "youtube",
    val thumbnail: String? = null,
    val addedByUid: String = "",
    val addedByName: String = "",
    val createdAtMs: Long = 0L,
)

data class Participant(
    val uid: String,
    val displayName: String,
    val role: String = "viewer",
    val muted: Boolean = false,
)

data class PlayerSync(
    val currentTime: Double = 0.0,
    val isPlaying: Boolean = false,
    val clientTimeMs: Long = 0L,
    val updatedBy: String = "",
    val videoUrl: String? = null,
    val videoId: String? = null,
)

data class FloatingReaction(
    val id: String,
    val emoji: String,
    val createdAtMs: Long = 0L,
)

private val REACTION_TTL_MS = 6000L
private val SOUND_TTL_MS = 6000L

/**
 * RoomRepository — single source of truth for the native room.
 *
 * Polls Firestore REST (room doc, messages, queue, participants, playerState,
 * typing) and exposes everything as StateFlows. Actions (send message, queue,
 * moderation, AI, playback sync) go through Firestore REST or the app's
 * /api/room endpoints using the user's Firebase ID token.
 */
class RoomRepository(
    private val context: Context,
    private val fs: FirestoreClient,
    private val apiBase: String,
    private val roomId: String,
    private val uid: String,
    private val displayName: String,
    private val idToken: () -> String,
    private val myRole: () -> String,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val _room = MutableStateFlow<RoomData?>(null)
    val room: StateFlow<RoomData?> = _room
    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages
    private val _queue = MutableStateFlow<List<QueueItem>>(emptyList())
    val queue: StateFlow<List<QueueItem>> = _queue
    private val _participants = MutableStateFlow<List<Participant>>(emptyList())
    val participants: StateFlow<List<Participant>> = _participants
    private val _playerSync = MutableStateFlow<PlayerSync>(PlayerSync())
    val playerSync: StateFlow<PlayerSync> = _playerSync
    private val _typing = MutableStateFlow<List<Pair<String, String>>>(emptyList()) // uid → name
    val typing: StateFlow<List<Pair<String, String>>> = _typing
    private val _aiCooldownSec = MutableStateFlow(0)
    val aiCooldownSec: StateFlow<Int> = _aiCooldownSec
    private val _floatingReactions = MutableStateFlow<List<FloatingReaction>>(emptyList())
    val floatingReactions: StateFlow<List<FloatingReaction>> = _floatingReactions
    private val _soundBanner = MutableStateFlow<String?>(null)
    val soundBanner: StateFlow<String?> = _soundBanner

    private val roomPath = "rooms/$roomId"
    private val messagesPath = "rooms/$roomId/messages"
    private val queuePath = "rooms/$roomId/queue"
    private val participantsPath = "rooms/$roomId/participants"
    private val playerStatePath = "rooms/$roomId/playerState/current"
    private val typingPath = "rooms/$roomId/typing"

    private var pollJob: Job? = null
    private var syncJob: Job? = null
    private var serverOffsetMs = 0L
    private var pollTicks = 0

    fun start() {
        if (pollJob != null) return
        pollJob = scope.launch {
            while (true) {
                try { refreshRoom() } catch (_: Exception) {}
                try { refreshParticipants() } catch (_: Exception) {}
                try { refreshMessages() } catch (_: Exception) {}
                try { refreshQueue() } catch (_: Exception) {}
                try { refreshTyping() } catch (_: Exception) {}
                try { refreshFloatingReactions() } catch (_: Exception) {}
                try { refreshSoundEffects() } catch (_: Exception) {}
                // Host heartbeat (~60s) so room cleanup never deletes a live room.
                pollTicks++
                if (pollTicks % 24 == 0 && myRole() == "host") heartbeat()
                delay(2500)
            }
        }
        syncJob = scope.launch {
            while (true) {
                try { refreshPlayerState() } catch (_: Exception) {}
                delay(1500)
            }
        }
        // Initial AI cooldown from aiState/summary
        scope.launch {
            try {
                val ai = fs.getDocument("rooms/$roomId/aiState/summary")
                val last = (ai?.get("lastSummaryAtMs") as? Long) ?: 0L
                val diff = System.currentTimeMillis() - last
                if (diff in 1..(5 * 60_000)) _aiCooldownSec.value = ((5 * 60_000 - diff) / 1000).toInt()
            } catch (_: Exception) {}
        }
    }

    fun stop() {
        pollJob?.cancel()
        syncJob?.cancel()
        scope.cancel()
    }

    // ── Reads ───────────────────────────────────────────────────────────

    private fun refreshRoom() {
        val doc = fs.getDocument(roomPath) ?: run { _room.value = null; return }
        // Server time offset for consistent message ordering.
        val updatedMs = (doc["updatedAt"] as? Long) ?: 0L
        if (updatedMs > 0) serverOffsetMs = System.currentTimeMillis() - updatedMs
        _room.value = RoomData(
            title = doc["title"] as? String ?: "",
            hostId = doc["hostId"] as? String ?: "",
            hostName = doc["hostName"] as? String ?: "",
            coHosts = (doc["coHosts"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
            capacity = ((doc["capacity"] as? Long) ?: 12L).toInt(),
            participantCount = ((doc["participantCount"] as? Long) ?: 0L).toInt(),
            status = doc["status"] as? String ?: "live",
            isLive = doc["isLive"] as? Boolean ?: false,
            locked = doc["locked"] as? Boolean ?: false,
            isPrivate = doc["isPrivate"] as? Boolean ?: false,
            inviteCode = doc["inviteCode"] as? String ?: "",
            videoUrl = doc["videoUrl"] as? String,
            videoType = doc["videoType"] as? String ?: "direct",
            thumbnail = doc["thumbnail"] as? String,
            vibeLighting = doc["vibeLighting"] as? Boolean ?: false,
            media = (doc["media"] as? Map<*, *>)?.filterKeys { it is String }?.mapKeys { it.key.toString() } ?: emptyMap(),
        )
    }

    private fun refreshFloatingReactions() {
        val docs = fs.listDocuments("rooms/$roomId/floatingReactions", pageSize = 30)
        val now = System.currentTimeMillis()
        val list = docs.mapNotNull { (id, f) ->
            val emoji = f["emoji"] as? String ?: return@mapNotNull null
            val at = (f["createdAtMs"] as? Number)?.toLong() ?: (f["createdAt"] as? Long) ?: now
            if (now - at > REACTION_TTL_MS) null else FloatingReaction(id, emoji, at)
        }
        _floatingReactions.value = list.sortedBy { it.createdAtMs }
    }

    private fun refreshSoundEffects() {
        val docs = fs.listDocuments("rooms/$roomId/soundEffects", pageSize = 20)
        val now = System.currentTimeMillis()
        val latest = docs.mapNotNull { (id, f) ->
            val key = f["soundKey"] as? String ?: return@mapNotNull null
            val at = (f["createdAtMs"] as? Number)?.toLong() ?: (f["createdAt"] as? Long) ?: 0L
            if (now - at > SOUND_TTL_MS) null else key to at
        }.maxByOrNull { it.second }
        _soundBanner.value = latest?.first
    }

    private fun heartbeat() {
        try {
            fs.setDocument(
                roomPath,
                mapOf<String, Any?>(),
                serverTimestampPaths = listOf("lastHeartbeat"),
            )
        } catch (_: Exception) {}
    }

    private fun refreshMessages() {
        val docs = fs.listDocuments(messagesPath, pageSize = 200)
        _messages.value = docs.map { (id, f) ->
            ChatMessage(
                id = id,
                uid = f["uid"] as? String ?: "",
                displayName = f["displayName"] as? String ?: "",
                text = f["text"] as? String ?: "",
                type = f["type"] as? String ?: "user",
                // Web-sent messages have serverTimestamp createdAt (parsed to
                // epoch ms by the client); native ones also carry createdAtMs.
                createdAtMs = ((f["createdAtMs"] as? Number)?.toLong()
                    ?: (f["createdAt"] as? Long)
                    ?: 0L) + serverOffsetMs,
                replyTo = f["replyTo"] as? Map<String, Any?>,
            )
        }.sortedBy { it.createdAtMs }
    }

    private fun refreshQueue() {
        val docs = fs.listDocuments(queuePath, pageSize = 100)
        _queue.value = docs.map { (id, f) ->
            QueueItem(
                id = id,
                title = f["title"] as? String ?: "Untitled",
                videoUrl = f["videoUrl"] as? String,
                videoId = f["videoId"] as? String,
                videoType = f["videoType"] as? String ?: "youtube",
                thumbnail = f["thumbnail"] as? String,
                addedByUid = f["addedByUid"] as? String ?: "",
                addedByName = f["addedByName"] as? String ?: "",
                createdAtMs = ((f["createdAtMs"] as? Number)?.toLong()
                    ?: (f["createdAt"] as? Long)
                    ?: 0L) + serverOffsetMs,
            )
        }.sortedBy { it.createdAtMs }
    }

    private fun refreshParticipants() {
        val docs = fs.listDocuments(participantsPath, pageSize = 200)
        _participants.value = docs.map { (id, f) ->
            Participant(
                uid = id,
                displayName = f["displayName"] as? String ?: "Viewer",
                role = f["role"] as? String ?: "viewer",
                muted = f["muted"] as? Boolean ?: false,
            )
        }
    }

    private fun refreshPlayerState() {
        val doc = fs.getDocument(playerStatePath) ?: return
        _playerSync.value = PlayerSync(
            currentTime = ((doc["currentTime"] as? Number)?.toDouble()) ?: 0.0,
            isPlaying = doc["isPlaying"] as? Boolean ?: false,
            clientTimeMs = (doc["clientTimeMs"] as? Number)?.toLong() ?: 0L,
            updatedBy = doc["updatedBy"] as? String ?: "",
            videoUrl = doc["videoUrl"] as? String,
            videoId = doc["videoId"] as? String,
        )
    }

    private fun refreshTyping() {
        val docs = fs.listDocuments(typingPath, pageSize = 100)
        val now = System.currentTimeMillis()
        val fresh = docs.mapNotNull { (id, f) ->
            val last = (f["lastTypedAt"] as? Long) ?: 0L
            if (now - last < 5000 && id != uid) id to (f["displayName"] as? String ?: "")
            else null
        }
        _typing.value = fresh
    }

    // ── Player sync writes (host / co-host only) ────────────────────────

    fun writePlayerState(currentTime: Double, isPlaying: Boolean) {
        if (myRole() == "viewer") return
        try {
                fs.setDocument(
                    playerStatePath,
                    mapOf(
                        "currentTime" to currentTime,
                        "isPlaying" to isPlaying,
                        "clientTimeMs" to System.currentTimeMillis(),
                        "updatedBy" to uid,
                    ),
                    serverTimestampPaths = listOf("updatedAt"),
                )
        } catch (_: Exception) {}
    }

    /** Freeze playback position (host/co-host) — used before leaving. */
    fun freezePlayerState(currentTime: Double) {
        if (myRole() == "viewer") return
        try {
            fs.setDocument(
                playerStatePath,
                mapOf(
                    "currentTime" to currentTime,
                    "isPlaying" to false,
                    "clientTimeMs" to System.currentTimeMillis(),
                    "updatedBy" to uid,
                    "frozenOnLeave" to true,
                ),
                serverTimestampPaths = listOf("updatedAt"),
            )
        } catch (_: Exception) {}
    }

    // ── Chat ────────────────────────────────────────────────────────────

    fun sendMessage(text: String) {
        val clean = text.trim()
            .replace(Regex("<[^>]*>"), "")
            .replace(Regex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]"), "")
            .take(500)
        if (clean.isEmpty()) return
        scope.launch {
            try {
                fs.setDocument(
                    messagesPath + "/" + java.util.UUID.randomUUID().toString(),
                    mapOf(
                        "uid" to uid,
                        "displayName" to displayName,
                        "text" to clean,
                        "type" to "user",
                        "createdAtMs" to System.currentTimeMillis(),
                    ),
                    serverTimestampPaths = listOf("createdAt"),
                    createOnly = true,
                )
            } catch (_: Exception) {}
        }
    }

    fun sendReaction(emoji: String) {
        scope.launch {
            try {
                fs.setDocument(
                    "rooms/$roomId/floatingReactions/" + java.util.UUID.randomUUID().toString(),
                    mapOf(
                        "uid" to uid,
                        "emoji" to emoji.take(16),
                        "createdAtMs" to System.currentTimeMillis(),
                    ),
                    serverTimestampPaths = listOf("createdAt"),
                    createOnly = true,
                )
            } catch (_: Exception) {}
        }
    }

    fun setTyping(isTyping: Boolean) {
        scope.launch {
            try {
                val path = "$typingPath/$uid"
                if (isTyping) {
                    // lastTypedAt comes from the REQUEST_TIME transform only —
                    // writing it both as a value and a transform would conflict.
                    fs.setDocument(
                        path,
                        mapOf("displayName" to displayName),
                        serverTimestampPaths = listOf("lastTypedAt"),
                    )
                } else {
                    fs.deleteDocument(path)
                }
            } catch (_: Exception) {}
        }
    }

    /** Host/co-host: start a queued item now — update room + delete the item. */
    fun playNext(item: QueueItem) {
        scope.launch {
            try {
                val fields = LinkedHashMap<String, Any?>()
                fields["videoUrl"] = item.videoUrl
                fields["videoType"] = item.videoType
                if (item.videoId != null) fields["videoId"] = item.videoId
                fields["isLive"] = item.videoType == "iptv" || item.videoType == "sports"
                fs.setDocument(roomPath, fields)
                fs.deleteDocument("$queuePath/${item.id}")
            } catch (_: Exception) {}
        }
    }

    // ── Queue ───────────────────────────────────────────────────────────

    fun addToQueue(title: String, videoUrl: String?, videoId: String?, videoType: String, thumbnail: String?) {
        if (videoUrl == null && videoId == null) return
        val current = _queue.value
        if (current.size >= 5) return
        scope.launch {
            try {
                fs.setDocument(
                    queuePath + "/" + java.util.UUID.randomUUID().toString(),
                    mapOf(
                        "title" to title.take(150),
                        "videoUrl" to videoUrl,
                        "videoId" to videoId,
                        "videoType" to videoType,
                        "thumbnail" to thumbnail,
                        "addedByUid" to uid,
                        "addedByName" to displayName,
                        "createdAtMs" to System.currentTimeMillis(),
                    ),
                    serverTimestampPaths = listOf("createdAt"),
                    createOnly = true,
                )
            } catch (_: Exception) {}
        }
    }

    fun removeFromQueue(itemId: String) {
        scope.launch { try { fs.deleteDocument("$queuePath/$itemId") } catch (_: Exception) {} }
    }

    // ── Moderation / room (via /api/room) ───────────────────────────────

    fun apiRoom(action: String, extra: Map<String, Any?> = emptyMap(), onResult: ((JSONObject?) -> Unit)? = null) {
        scope.launch {
            try {
                val body = JSONObject()
                body.put("action", action)
                body.put("roomId", roomId)
                for ((k, v) in extra) body.put(k, v)
                val req = Request.Builder()
                    .url("$apiBase/api/room")
                    .header("Authorization", "Bearer ${idToken()}")
                    .header("Content-Type", "application/json")
                    .post(body.toString().toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { res ->
                    val text = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        android.util.Log.w("RoomRepo", "api/room $action failed: ${res.code} $text")
                        onResult?.invoke(null)
                    } else {
                        onResult?.invoke(JSONObject(text))
                    }
                }
            } catch (e: Exception) {
                android.util.Log.w("RoomRepo", "api/room $action error", e)
                onResult?.invoke(null)
            }
        }
    }

    fun kick(uid: String, onResult: (Boolean) -> Unit) =
        apiRoom("kick", mapOf("uid" to uid)) { r -> onResult(r?.optBoolean("success", false) == true) }

    fun promote(uid: String, role: String, onResult: (Boolean) -> Unit) =
        apiRoom("promote", mapOf("uid" to uid, "role" to role)) { r -> onResult(r?.optBoolean("success", false) == true) }

    fun mute(uid: String, muted: Boolean, onResult: (Boolean) -> Unit) =
        apiRoom("mute", mapOf("uid" to uid, "muted" to muted)) { r -> onResult(r?.optBoolean("success", false) == true) }

    fun toggleLock(locked: Boolean) {
        scope.launch { try { fs.setDocument(roomPath, mapOf("locked" to locked)) } catch (_: Exception) {} }
    }

    fun endRoom() = apiRoom("end", mapOf("uid" to uid))

    fun leaveRoom(currentTimeSec: Double) {
        freezePlayerState(currentTimeSec)
        apiRoom("leave", mapOf("uid" to uid, "currentTime" to currentTimeSec))
    }

    fun updateTitle(newTitle: String) {
        scope.launch {
            try { fs.setDocument(roomPath, mapOf("title" to newTitle.take(80))) } catch (_: Exception) {}
        }
    }

    fun setVibeLighting(enabled: Boolean) {
        scope.launch {
            try { fs.setDocument(roomPath, mapOf("vibeLighting" to enabled)) } catch (_: Exception) {}
        }
    }

    /** Host/co-host: switch the room to a new stream (paste-URL change video). */
    fun changeVideo(url: String, videoType: String, isLive: Boolean) {
        scope.launch {
            try {
                fs.setDocument(
                    roomPath,
                    mapOf(
                        "videoUrl" to url,
                        "videoType" to videoType,
                        "activityType" to videoType,
                        "isLive" to isLive,
                        "media" to emptyMap<String, Any?>(),
                    ),
                )
                fs.setDocument(
                    playerStatePath,
                    mapOf(
                        "videoUrl" to url,
                        "videoType" to videoType,
                        "currentTime" to 0.0,
                        "isPlaying" to false,
                        "updatedBy" to uid,
                    ),
                    serverTimestampPaths = listOf("updatedAt"),
                )
            } catch (_: Exception) {}
        }
    }

    // ── AI tools ────────────────────────────────────────────────────────

    fun aiSummary() = apiRoom("summary", mapOf("uid" to uid)) {
        if (it != null) {
            _aiCooldownSec.value = 300
            scope.launch { while (_aiCooldownSec.value > 0) { delay(1000); _aiCooldownSec.value -= 1 } }
        }
    }

    fun aiCatchup() = apiRoom("catchup", mapOf("uid" to uid))

    fun aiQuiz() = apiRoom("generatequiz", mapOf("uid" to uid))

    fun voteQuiz(optionIndex: Int) = apiRoom("votequiz", mapOf("uid" to uid, "optionIndex" to optionIndex))

    // ── Share ───────────────────────────────────────────────────────────

    fun shareLink(): String {
        val code = _room.value?.inviteCode
        return if (!code.isNullOrEmpty()) {
            "https://chan-yz3p.vercel.app/room/$roomId?invite=$code"
        } else {
            "https://chan-yz3p.vercel.app/room/$roomId"
        }
    }

    val isController: Boolean
        get() {
            val r = _room.value ?: return false
            return r.hostId == uid || r.coHosts.contains(uid)
        }
}
