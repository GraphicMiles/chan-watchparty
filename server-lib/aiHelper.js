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
