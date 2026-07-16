/**
 * MKV Cue / cluster index helpers for seek-by-time remux.
 *
 * Reads only a small prefix (and optionally a SeekHead-targeted Cues block)
 * via HTTP Range so Hobby can jump mid-file without scanning 600MB.
 */

const EBML_HEADER = 0x1a45dfa3
const SEGMENT = 0x18538067
const SEEK_HEAD = 0x114d9b74
const SEEK = 0x4dbb
const SEEK_ID = 0x53ab
const SEEK_POSITION = 0x53ac
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION_ID = 0x4489
const CUES = 0x1c53bb6b
const CUE_POINT = 0xbb
const CUE_TIME = 0xb3
const CUE_TRACK_POSITIONS = 0xb7
const CUE_CLUSTER_POSITION = 0xf1
const CLUSTER = 0x1f43b675

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function readVintId(buf, offset) {
  if (offset >= buf.length) return null
  const first = buf[offset]
  let width = 1
  let mask = 0x80
  while (mask > 0 && !(first & mask)) {
    width++
    mask >>= 1
  }
  if (width > 4 || offset + width > buf.length) return null
  let value = 0
  for (let i = 0; i < width; i++) value = (value << 8) | buf[offset + i]
  return { value, width }
}

function readVintSize(buf, offset) {
  if (offset >= buf.length) return null
  const first = buf[offset]
  let width = 1
  let mask = 0x80
  while (mask > 0 && !(first & mask)) {
    width++
    mask >>= 1
  }
  if (width > 8 || offset + width > buf.length) return null
  let value = first & (mask - 1)
  let allOnes = value === (mask - 1)
  for (let i = 1; i < width; i++) {
    const b = buf[offset + i]
    value = (value << 8) | b
    if (b !== 0xff) allOnes = false
  }
  if (allOnes) value = -1
  return { value, width }
}

function readUInt(buf, offset, length) {
  let v = 0
  for (let i = 0; i < length; i++) v = (v << 8) | buf[offset + i]
  return v >>> 0
}

async function rangeGet(url, headers, start, end, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        ...headers,
        Range: `bytes=${start}-${end}`,
        'User-Agent': headers['User-Agent'] || UA,
        Accept: '*/*',
      },
    })
    if (!res.ok && res.status !== 206) {
      throw new Error(`Range fetch failed HTTP ${res.status}`)
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Walk top-level EBML in a buffer; return segment data start offset (file absolute)
 * and list of segment children { id, dataStart, dataSize } when fully present.
 */
function scanSegment(buf) {
  let offset = 0
  let segmentDataStart = null
  const children = []

  while (offset + 2 < buf.length) {
    const idR = readVintId(buf, offset)
    if (!idR) break
    const szR = readVintSize(buf, offset + idR.width)
    if (!szR) break
    const headerSize = idR.width + szR.width
    const dataSize = szR.value
    const dataStart = offset + headerSize

    if (idR.value === EBML_HEADER) {
      if (dataSize < 0 || dataStart + dataSize > buf.length) break
      offset = dataStart + dataSize
      continue
    }

    if (idR.value === SEGMENT) {
      segmentDataStart = dataStart
      // Walk children inside segment as far as buffer allows
      let pos = dataStart
      const segmentEnd = dataSize >= 0 ? dataStart + dataSize : buf.length
      while (pos + 2 < Math.min(segmentEnd, buf.length)) {
        const cId = readVintId(buf, pos)
        if (!cId) break
        const cSz = readVintSize(buf, pos + cId.width)
        if (!cSz) break
        const cHeader = cId.width + cSz.width
        const cDataStart = pos + cHeader
        const cDataSize = cSz.value
        if (cDataSize < 0) {
          children.push({ id: cId.value, dataStart: cDataStart, dataSize: -1, elementStart: pos })
          break
        }
        if (cDataStart + cDataSize > buf.length) {
          // Partial child — record start for SeekHead/Cues fetch
          children.push({
            id: cId.value,
            dataStart: cDataStart,
            dataSize: cDataSize,
            elementStart: pos,
            incomplete: true,
          })
          break
        }
        children.push({
          id: cId.value,
          dataStart: cDataStart,
          dataSize: cDataSize,
          elementStart: pos,
        })
        pos = cDataStart + cDataSize
      }
      break
    }

    if (dataSize < 0 || dataStart + dataSize > buf.length) break
    offset = dataStart + dataSize
  }

  return { segmentDataStart, children }
}

function parseInfo(data) {
  let scale = 1000000
  let durationNs = 0
  let offset = 0
  while (offset < data.length) {
    const idR = readVintId(data, offset)
    if (!idR) break
    const szR = readVintSize(data, offset + idR.width)
    if (!szR || szR.value < 0) break
    const hs = idR.width + szR.width
    const ds = szR.value
    if (offset + hs + ds > data.length) break
    const el = data.subarray(offset + hs, offset + hs + ds)
    if (idR.value === TIMECODE_SCALE) {
      scale = readUInt(el, 0, el.length) || scale
    } else if (idR.value === DURATION_ID) {
      if (el.length === 4) durationNs = el.readFloatBE(0) * scale
      else if (el.length === 8) durationNs = el.readDoubleBE(0) * scale
    }
    offset += hs + ds
  }
  return { timecodeScale: scale, durationNs }
}

function parseSeekHead(data) {
  const map = new Map()
  let offset = 0
  while (offset < data.length) {
    const idR = readVintId(data, offset)
    if (!idR) break
    const szR = readVintSize(data, offset + idR.width)
    if (!szR || szR.value < 0) break
    const hs = idR.width + szR.width
    const ds = szR.value
    if (offset + hs + ds > data.length) break
    if (idR.value === SEEK) {
      const seekData = data.subarray(offset + hs, offset + hs + ds)
      let sid = null
      let spos = null
      let so = 0
      while (so < seekData.length) {
        const i2 = readVintId(seekData, so)
        if (!i2) break
        const s2 = readVintSize(seekData, so + i2.width)
        if (!s2 || s2.value < 0) break
        const h2 = i2.width + s2.width
        const d2 = s2.value
        if (so + h2 + d2 > seekData.length) break
        const ed = seekData.subarray(so + h2, so + h2 + d2)
        if (i2.value === SEEK_ID) {
          // SeekID is the EBML id bytes of the target element
          let v = 0
          for (let i = 0; i < ed.length; i++) v = (v << 8) | ed[i]
          sid = v
        } else if (i2.value === SEEK_POSITION) {
          spos = readUInt(ed, 0, ed.length)
        }
        so += h2 + d2
      }
      if (sid != null && spos != null) map.set(sid, spos)
    }
    offset += hs + ds
  }
  return map
}

function parseCues(data, timecodeScale, segmentDataStart) {
  const cues = []
  let offset = 0
  while (offset < data.length) {
    const idR = readVintId(data, offset)
    if (!idR) break
    const szR = readVintSize(data, offset + idR.width)
    if (!szR || szR.value < 0) break
    const hs = idR.width + szR.width
    const ds = szR.value
    if (offset + hs + ds > data.length) break
    if (idR.value === CUE_POINT) {
      const point = data.subarray(offset + hs, offset + hs + ds)
      let cueTime = null
      let clusterPos = null
      let po = 0
      while (po < point.length) {
        const i2 = readVintId(point, po)
        if (!i2) break
        const s2 = readVintSize(point, po + i2.width)
        if (!s2 || s2.value < 0) break
        const h2 = i2.width + s2.width
        const d2 = s2.value
        if (po + h2 + d2 > point.length) break
        const ed = point.subarray(po + h2, po + h2 + d2)
        if (i2.value === CUE_TIME) {
          cueTime = readUInt(ed, 0, ed.length)
        } else if (i2.value === CUE_TRACK_POSITIONS) {
          let to = 0
          while (to < ed.length) {
            const i3 = readVintId(ed, to)
            if (!i3) break
            const s3 = readVintSize(ed, to + i3.width)
            if (!s3 || s3.value < 0) break
            const h3 = i3.width + s3.width
            const d3 = s3.value
            if (to + h3 + d3 > ed.length) break
            const e3 = ed.subarray(to + h3, to + h3 + d3)
            if (i3.value === CUE_CLUSTER_POSITION) {
              clusterPos = readUInt(e3, 0, e3.length)
            }
            to += h3 + d3
          }
        }
        po += h2 + d2
      }
      if (cueTime != null && clusterPos != null && segmentDataStart != null) {
        const timeSec = (cueTime * timecodeScale) / 1e9
        const fileOffset = segmentDataStart + clusterPos
        cues.push({ timeSec, fileOffset, cueTime })
      }
    }
    offset += hs + ds
  }
  cues.sort((a, b) => a.timeSec - b.timeSec)
  return cues
}

/**
 * Build cue index for a remote MKV URL.
 * @returns {{ cues: Array<{timeSec:number,fileOffset:number}>, durationSec: number|null, segmentDataStart: number|null, headerEndOffset: number }}
 */
export async function buildMkvCueIndex(url, headers = {}) {
  const PREFIX = 3 * 1024 * 1024 // 3 MiB prefix for SeekHead/Cues
  const prefix = await rangeGet(url, headers, 0, PREFIX - 1, 4500)
  if (!prefix.length || prefix[0] !== 0x1a) {
    throw new Error('Not an MKV file (missing EBML magic)')
  }

  const { segmentDataStart, children } = scanSegment(prefix)
  if (segmentDataStart == null) throw new Error('MKV Segment not found in prefix')

  let timecodeScale = 1000000
  let durationSec = null
  let cues = []
  let headerEndOffset = segmentDataStart

  const infoChild = children.find((c) => c.id === INFO && !c.incomplete)
  if (infoChild) {
    const info = parseInfo(prefix.subarray(infoChild.dataStart, infoChild.dataStart + infoChild.dataSize))
    timecodeScale = info.timecodeScale || timecodeScale
    if (info.durationNs > 0) durationSec = info.durationNs / 1e9
  }

  // First cluster in prefix ≈ end of header region (good re-fetch bound)
  const firstCluster = children.find((c) => c.id === CLUSTER)
  if (firstCluster) {
    headerEndOffset = firstCluster.elementStart
  } else {
    // last complete child end
    for (const c of children) {
      if (!c.incomplete && c.dataSize >= 0) {
        headerEndOffset = Math.max(headerEndOffset, c.dataStart + c.dataSize)
      }
    }
  }

  let cuesChild = children.find((c) => c.id === CUES)
  if (cuesChild && !cuesChild.incomplete) {
    cues = parseCues(
      prefix.subarray(cuesChild.dataStart, cuesChild.dataStart + cuesChild.dataSize),
      timecodeScale,
      segmentDataStart,
    )
  } else {
    // SeekHead → Cues absolute position
    const seekChild = children.find((c) => c.id === SEEK_HEAD && !c.incomplete)
    if (seekChild) {
      const seeks = parseSeekHead(
        prefix.subarray(seekChild.dataStart, seekChild.dataStart + seekChild.dataSize),
      )
      const cuesRel = seeks.get(CUES)
      if (cuesRel != null) {
        const cuesFileStart = segmentDataStart + cuesRel
        // Fetch Cues element: need element header + data. Grab up to 512KB.
        const cuesBuf = await rangeGet(url, headers, cuesFileStart, cuesFileStart + 512 * 1024 - 1, 4000)
        const idR = readVintId(cuesBuf, 0)
        const szR = idR ? readVintSize(cuesBuf, idR.width) : null
        if (idR && szR && idR.value === CUES && szR.value >= 0) {
          const hs = idR.width + szR.width
          let data = cuesBuf.subarray(hs, hs + szR.value)
          if (data.length < szR.value) {
            const more = await rangeGet(
              url,
              headers,
              cuesFileStart + hs,
              cuesFileStart + hs + szR.value - 1,
              5000,
            )
            data = more
          }
          cues = parseCues(data, timecodeScale, segmentDataStart)
        }
      }
    }
  }

  // Fallback: if still no cues, invent coarse index from first cluster only.
  // Without Cues, mid-file seeks cannot jump accurately (will feel slow / wrong).
  if (!cues.length && firstCluster) {
    cues = [{ timeSec: 0, fileOffset: firstCluster.elementStart, cueTime: 0 }]
  }

  return {
    cues,
    durationSec,
    segmentDataStart,
    headerEndOffset: Math.max(headerEndOffset, Math.min(prefix.length, 512 * 1024)),
    timecodeScale,
  }
}

/**
 * Find the best cluster file offset for a target time (seconds).
 * Returns offset at or before target; never past end.
 */
export function clusterOffsetForTime(index, timeSec) {
  const t = Math.max(0, Number(timeSec) || 0)
  const cues = index?.cues || []
  if (!cues.length) return { fileOffset: 0, cueTimeSec: 0 }

  // Binary search last cue with timeSec <= t
  let lo = 0
  let hi = cues.length - 1
  let best = cues[0]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].timeSec <= t) {
      best = cues[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return { fileOffset: best.fileOffset, cueTimeSec: best.timeSec }
}

/** In-memory cache keyed by URL (short TTL). */
const indexCache = new Map()
const INDEX_TTL_MS = 10 * 60 * 1000

export async function getCachedMkvCueIndex(url, headers = {}) {
  const key = String(url)
  const hit = indexCache.get(key)
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.index
  const index = await buildMkvCueIndex(url, headers)
  indexCache.set(key, { at: Date.now(), index })
  // Cap cache size
  if (indexCache.size > 50) {
    const first = indexCache.keys().next().value
    indexCache.delete(first)
  }
  return index
}
