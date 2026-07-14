import { FieldValue } from './firebaseAdmin.js'

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
const QUIZ_COOLDOWN_MS = 60 * 1000 // 60 seconds

export async function generateAiSummary(db, user, body) {
  const { roomId } = body || {}
  if (!roomId) throw Object.assign(new Error('Missing roomId'), { status: 400 })

  const aiStateRef = db.collection('rooms').doc(roomId).collection('aiState').doc('summary')
  const aiStateSnap = await aiStateRef.get()
  const now = Date.now()

  if (aiStateSnap.exists) {
    const lastAt = aiStateSnap.data()?.lastSummaryAt?.toMillis?.() || aiStateSnap.data()?.lastSummaryAtMs || 0
    if (now - lastAt < COOLDOWN_MS) {
      const remainingSec = Math.ceil((COOLDOWN_MS - (now - lastAt)) / 1000)
      return {
        onCooldown: true,
        remainingSec,
        message: `AI Summary is on a 5-minute cooldown. Please wait ${Math.ceil(remainingSec / 60)} min before requesting again.`,
      }
    }
  }

  if (!GROQ_API_KEY) {
    throw Object.assign(new Error('GROQ_API_KEY is not configured on the server. Please add GROQ_API_KEY to your environment variables.'), { status: 503 })
  }

  const roomSnap = await db.collection('rooms').doc(roomId).get()
  if (!roomSnap.exists) throw Object.assign(new Error('Room not found'), { status: 404 })
  const roomData = roomSnap.data()

  const msgsSnap = await db
    .collection('rooms')
    .doc(roomId)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(30)
    .get()

  const messagesList = msgsSnap.docs
    .map((d) => d.data())
    .filter((m) => m.type !== 'system' && m.type !== 'bot' && m.text)
    .reverse()

  const chatTranscript = messagesList.length
    ? messagesList.map((m) => `${m.displayName}: ${m.text}`).join('\n')
    : 'No user messages sent recently.'

  const prompt = `You are ChanBot 🤖, a helpful, energetic AI assistant inside a live watch party room on Chan.
Room Title: "${roomData.title || 'Live Watch Party'}"
Activity: ${roomData.videoType || roomData.activityType || 'Video Stream'}

Recent Chat Transcript:
${chatTranscript}

Task: Write a concise, engaging 3-4 sentence summary of what everyone is watching and discussing in the room right now. Highlight key reactions or topics. Keep your tone friendly and direct.`

  const groqRes = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0.7,
    }),
  })

  if (!groqRes.ok) {
    const errJson = await groqRes.json().catch(() => ({}))
    throw new Error(errJson.error?.message || `Groq API returned HTTP ${groqRes.status}`)
  }

  const groqData = await groqRes.json()
  const summaryText = groqData.choices?.[0]?.message?.content?.trim() || 'No summary generated.'

  const botMsg = {
    uid: 'chan-bot-ai',
    displayName: 'ChanBot 🤖',
    text: `📊 AI Summary: ${summaryText}`,
    type: 'bot',
    createdAt: FieldValue.serverTimestamp(),
  }
  await db.collection('rooms').doc(roomId).collection('messages').add(botMsg)

  await aiStateRef.set({
    lastSummaryAt: FieldValue.serverTimestamp(),
    lastSummaryAtMs: now,
    requestedBy: user.uid,
  }, { merge: true })

  return { success: true, summary: summaryText }
}

export async function generateSmartCatchup(db, user, body) {
  const { roomId } = body || {}
  if (!roomId) throw Object.assign(new Error('Missing roomId'), { status: 400 })

  if (!GROQ_API_KEY) {
    throw Object.assign(new Error('GROQ_API_KEY not configured on server.'), { status: 503 })
  }

  const roomSnap = await db.collection('rooms').doc(roomId).get()
  if (!roomSnap.exists) throw Object.assign(new Error('Room not found'), { status: 404 })
  const roomData = roomSnap.data()

  const playerSnap = await db.collection('rooms').doc(roomId).collection('playerState').doc('current').get()
  const currentTimeSec = playerSnap.exists ? Number(playerSnap.data().currentTime || 0) : 0
  const minutesIn = Math.max(1, Math.floor(currentTimeSec / 60))

  const msgsSnap = await db
    .collection('rooms')
    .doc(roomId)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()

  const chatTranscript = msgsSnap.docs
    .map((d) => d.data())
    .filter((m) => m.type !== 'system' && m.type !== 'bot' && m.text)
    .reverse()
    .map((m) => `${m.displayName}: ${m.text}`)
    .join('\n') || 'Quiet chat room.'

  const prompt = `You are ChanBot 🤖. A new viewer just joined the watch party room for "${roomData.title || 'the video'}".
The video is currently roughly ${minutesIn} minutes into playback.
Recent chat:
${chatTranscript}

Task: Write a 3-bullet spoiler-free recap of what the premise is or what has happened up to roughly minute ${minutesIn}, plus a 1-sentence welcoming greeting for the latecomer so they can jump right in. Format cleanly with bullet points.`

  const groqRes = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.7,
    }),
  })

  if (!groqRes.ok) {
    throw new Error(`Groq API returned HTTP ${groqRes.status}`)
  }

  const groqData = await groqRes.json()
  const catchupText = groqData.choices?.[0]?.message?.content?.trim() || 'No recap generated.'

  return { success: true, catchup: catchupText, minutesIn, title: roomData.title }
}

export async function generateRoomQuiz(db, user, body) {
  const { roomId } = body || {}
  if (!roomId) throw Object.assign(new Error('Missing roomId'), { status: 400 })

  if (!GROQ_API_KEY) {
    throw Object.assign(new Error('GROQ_API_KEY not configured on server.'), { status: 503 })
  }

  const quizRef = db.collection('rooms').doc(roomId).collection('quiz').doc('current')
  const quizSnap = await quizRef.get()
  const now = Date.now()

  if (quizSnap.exists) {
    const lastAt = quizSnap.data()?.createdAtMs || 0
    if (now - lastAt < QUIZ_COOLDOWN_MS) {
      const remainingSec = Math.ceil((QUIZ_COOLDOWN_MS - (now - lastAt)) / 1000)
      return {
        onCooldown: true,
        remainingSec,
        message: `Quiz generation on cooldown. Please wait ${remainingSec}s.`,
      }
    }
  }

  const roomSnap = await db.collection('rooms').doc(roomId).get()
  if (!roomSnap.exists) throw Object.assign(new Error('Room not found'), { status: 404 })
  const roomData = roomSnap.data()

  const prompt = `Generate a fun, interactive 4-option multiple choice trivia question about the movie/series/topic: "${roomData.title || 'Pop Culture & Cinema'}".
Return STRICT valid JSON ONLY (no markdown code blocks, no trailing commas) with exact structure:
{
  "question": "What is...?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctIndex": 0,
  "funFact": "A brief interesting fact about this answer."
}`

  const groqRes = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 350,
      temperature: 0.8,
    }),
  })

  if (!groqRes.ok) {
    throw new Error(`Groq API returned HTTP ${groqRes.status}`)
  }

  const groqData = await groqRes.json()
  let rawContent = groqData.choices?.[0]?.message?.content?.trim() || '{}'
  rawContent = rawContent.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim()

  let parsed = {}
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    parsed = {
      question: `What year or genre does "${roomData.title}" best belong to?`,
      options: ['Action / Thriller', 'Sci-Fi / Drama', 'Classic Cinema', 'Modern Blockbuster'],
      correctIndex: 1,
      funFact: `"${roomData.title}" is a popular room watch party topic on Chan!`,
    }
  }

  if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length < 4) {
    throw new Error('Could not parse valid quiz from AI response')
  }

  const quizData = {
    question: parsed.question.slice(0, 200),
    options: parsed.options.slice(0, 4).map((o) => String(o).slice(0, 80)),
    correctIndex: Number(parsed.correctIndex) || 0,
    funFact: String(parsed.funFact || '').slice(0, 200),
    votes: {},
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: now,
    createdByUid: user.uid,
    createdByName: user.displayName || 'Host',
    active: true,
  }

  await quizRef.set(quizData)

  return { success: true, quiz: quizData }
}

export async function voteRoomQuiz(db, user, body) {
  const { roomId, optionIndex } = body || {}
  if (!roomId || optionIndex === undefined) throw Object.assign(new Error('Missing roomId or optionIndex'), { status: 400 })

  const quizRef = db.collection('rooms').doc(roomId).collection('quiz').doc('current')
  const snap = await quizRef.get()
  if (!snap.exists || !snap.data().active) throw new Error('No active quiz in room')

  await quizRef.update({
    [`votes.${user.uid}`]: Number(optionIndex),
  })

  return { success: true }
}

export async function generateAiSubtitles(db, user, body) {
  const { roomId, currentTimeSec = 0 } = body || {}
  if (!roomId) throw Object.assign(new Error('Missing roomId'), { status: 400 })

  if (!GROQ_API_KEY) {
    throw Object.assign(new Error('GROQ_API_KEY not configured on server.'), { status: 503 })
  }

  const roomSnap = await db.collection('rooms').doc(roomId).get()
  if (!roomSnap.exists) throw Object.assign(new Error('Room not found'), { status: 404 })
  const roomData = roomSnap.data()

  const title = roomData.title || 'Ongoing Movie Stream'
  const videoType = roomData.videoType || roomData.activityType || 'video'
  const isIptv = videoType === 'iptv' || roomData.source === 'iptv'
  const isLive = Boolean(roomData.isLive || isIptv)

  // Get current playback position for context
  const playerSnap = await db.collection('rooms').doc(roomId).collection('playerState').doc('current').get()
  const playbackTime = playerSnap.exists ? Number(playerSnap.data().currentTime || 0) : 0

  // Get recent chat messages for context — what are viewers actually reacting to?
  const msgsSnap = await db
    .collection('rooms')
    .doc(roomId)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(15)
    .get()
  const chatClues = msgsSnap.docs
    .map((d) => d.data())
    .filter((m) => m.type !== 'system' && m.type !== 'bot' && m.text)
    .reverse()
    .map((m) => `${m.displayName}: ${m.text}`)
    .join('\n')

  const startSec = Math.max(0, Math.floor(Number(currentTimeSec) || 0))
  const formatCueTime = (sec) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`
  }

  const startStr = formatCueTime(startSec + 1)
  const endStr = formatCueTime(startSec + 6)
  const minutesIn = Math.max(0, Math.floor(playbackTime / 60))
  const timeInfo = startSec > 10
    ? `Playback is currently around timestamp ${formatCueTime(startSec)} (${minutesIn} minutes in). Start your WebVTT cues around timestamp ${startStr} --> ${endStr}, continuing sequentially across ~180 seconds.`
    : `Start cues from 00:00:01.000 --> 00:00:05.000, continuing sequentially across ~180 seconds.`

  // Build a more accurate prompt that uses chat context + content type awareness
  const contentContext = isIptv || isLive
    ? `This is a LIVE TV/IPTV stream (${title}). For live content, generate descriptive scene cues and ambient sound descriptions that a viewer would hear while watching a live broadcast. Do NOT invent specific dialogue — focus on sound cues, atmosphere, and descriptive narration of what a typical live broadcast of "${title}" would contain.`
    : `This is a "${title}" playback session (~${minutesIn} minutes in). The viewers are in a watch party reacting in real time. Here is what viewers are currently saying in chat (use this to understand what's happening on screen right now):\n${chatClues || '(no recent chat — use title context only)'}\n\nIMPORTANT: Use the chat reactions above to infer what is happening on screen. If viewers mention specific scenes, characters, or moments, reference those. If no chat context is available, generate only sound cues and atmospheric descriptions — do NOT fabricate character dialogue unless you are certain of what the characters would say. Prefer [sound effect] descriptions over invented dialogue.`

  const prompt = `You are a professional closed-caption engineer creating an AI-ASSISTED subtitle track for a watch party.

Title: "${title}"
Type: ${isIptv || isLive ? 'Live TV / IPTV' : 'Movie / Series'}
${timeInfo}

${contentContext}

RULES — follow these strictly:
1. Output ONLY valid WebVTT format starting with "WEBVTT" on line 1
2. Each cue should be 3-6 seconds long
3. PREFER sound/atmosphere cues over dialogue unless you are very confident about the dialogue
4. Use [brackets] for non-speech sounds: [music plays], [crowd cheering], [door slams], [dramatic music swells], [explosion in background], etc.
5. For live TV, describe what's happening: [commentator speaks], [halftime analysis], [crowd erupts], [gameplay continues]
6. If the title suggests sports/news, use appropriate terminology
7. Do NOT repeat the same cue text multiple times
8. Do NOT add markdown code blocks — just raw WebVTT
9. Generate cues for approximately 3 minutes of content
10. Time codes must be sequential and increasing`

  const groqRes = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.5,
    }),
  })

  if (!groqRes.ok) {
    throw new Error(`Groq API returned HTTP ${groqRes.status}`)
  }

  const groqData = await groqRes.json()
  let vttText = groqData.choices?.[0]?.message?.content?.trim() || ''
  vttText = vttText.replace(/^```vtt\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  if (!vttText.startsWith('WEBVTT')) {
    vttText = `WEBVTT\n\n${startStr} --> ${endStr}\n[Stream content for ${title}]\n\n` + vttText
  }

  await db.collection('rooms').doc(roomId).update({
    subtitleVtt: vttText,
    subtitleUpdatedAt: FieldValue.serverTimestamp(),
  })

  return { success: true, subtitleVtt: vttText }
}
