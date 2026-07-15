/**
 * MKV → fMP4 Remuxer
 *
 * Streaming Matroska (MKV) to fragmented MP4 remuxer in pure JavaScript.
 * No ffmpeg needed — just repackages the same video/audio data into an MP4 container.
 *
 * Supported codecs:
 *   Video: V_MPEG4/ISO/AVC (H.264)
 *   Audio: A_AAC, A_MPEG/L3 (MP3)
 *
 * How it works:
 *   1. Parse MKV/EBML header (Info + Tracks elements)
 *   2. Emit ftyp + moov MP4 boxes with codec info
 *   3. For each MKV Cluster, emit moof + mdat fMP4 fragments
 *   4. Browser's <video> plays the fMP4 stream natively
 *
 * Limitations:
 *   - No seeking support (progressive download only)
 *   - No H.265/HEVC support yet (can be added later)
 *   - Simple lacing only (no Xiph or EBML lacing)
 *   - Single video + single audio track
 */

import { Transform } from 'node:stream'

// ═══════════════════════════════════════════════════════════════════
// EBML Element IDs
// ═══════════════════════════════════════════════════════════════════
const EBML_HEADER = 0x1A45DFA3
const SEGMENT = 0x18538067
const INFO = 0x1549A966
const TIMECODE_SCALE_ID = 0x2AD7B1
const DURATION_ID = 0x4489
const TRACKS = 0x1654AE6B
const TRACK_ENTRY = 0xAE
const TRACK_NUMBER = 0xD7
const TRACK_UID = 0x73C5
const TRACK_TYPE = 0x83
const CODEC_ID = 0x86
const CODEC_PRIVATE = 0x63A2
const DEFAULT_DURATION = 0x23E383
const VIDEO_SETTINGS = 0xE0
const PIXEL_WIDTH = 0xB0
const PIXEL_HEIGHT = 0xBA
const AUDIO_SETTINGS = 0xE1
const SAMPLING_FREQUENCY = 0xB5
const OUTPUT_SAMPLING_FREQUENCY = 0x78B5
const CHANNELS = 0x9F
const BIT_DEPTH = 0x6264
const CLUSTER = 0x1F43B675
const CLUSTER_TIMECODE = 0xE7
const SIMPLE_BLOCK = 0xA3
const BLOCK_GROUP = 0xA0
const BLOCK = 0xA1
const BLOCK_DURATION = 0x9B
const REFERENCE_BLOCK = 0xFB

// Track types
const TRACK_TYPE_VIDEO = 1
const TRACK_TYPE_AUDIO = 2

// ═══════════════════════════════════════════════════════════════════
// EBML VINT Parsing
// ═══════════════════════════════════════════════════════════════════

/**
 * Read a VINT (Variable-Length Integer) for element IDs.
 * The marker bit IS included in the returned value.
 */
function readVINT_ID(buf, offset) {
  if (offset >= buf.length) return null
  const firstByte = buf[offset]
  let width = 1
  let mask = 0x80
  while (mask > 0 && !(firstByte & mask)) {
    width++
    mask >>= 1
  }
  if (width > 4 || offset + width > buf.length) return null
  let value = 0
  for (let i = 0; i < width; i++) {
    value = (value << 8) | buf[offset + i]
  }
  return { value, width }
}

/**
 * Read a VINT for element sizes.
 * The marker bit is NOT included in the returned value.
 * Returns -1 for "unknown" size (all data bits set).
 */
function readVINT_SIZE(buf, offset) {
  if (offset >= buf.length) return null
  const firstByte = buf[offset]
  let width = 1
  let mask = 0x80
  while (mask > 0 && !(firstByte & mask)) {
    width++
    mask >>= 1
  }
  if (width > 8 || offset + width > buf.length) return null
  // Clear the marker bit and read the value
  let value = firstByte & (mask - 1)
  for (let i = 1; i < width; i++) {
    value = (value * 256) + buf[offset + i]
  }
  // Check for "unknown" size
  if (width === 1 && value === 0x7F) return { value: -1, width }
  if (width === 2 && value === 0x3FFF) return { value: -1, width }
  if (width === 3 && value === 0x1FFFFF) return { value: -1, width }
  if (width === 4 && value === 0x0FFFFFFF) return { value: -1, width }
  if (width >= 5) {
    // For wider VINTs, check if all data bits are set
    let maxVal = mask - 1
    for (let i = 1; i < width; i++) maxVal = maxVal * 256 + 0xFF
    if (value === maxVal) return { value: -1, width }
  }
  return { value, width }
}

/**
 * Read an unsigned integer from buffer (big-endian).
 */
function readUInt(buf, offset, size) {
  let val = 0
  for (let i = 0; i < size; i++) {
    val = (val * 256) + buf[offset + i]
  }
  return val
}

/**
 * Read a signed integer from buffer (big-endian).
 */
function readInt(buf, offset, size) {
  let val = readUInt(buf, offset, size)
  const bits = size * 8
  if (bits < 32 && val >= (1 << (bits - 1))) {
    val -= (1 << bits)
  } else if (bits === 32 && val > 0x7FFFFFFF) {
    val = val - 0x100000000
  }
  return val
}

/**
 * Read a VINT value (for TrackNumber etc.). Marker bit excluded.
 */
function readVINT_Value(buf, offset) {
  if (offset >= buf.length) return null
  const firstByte = buf[offset]
  let width = 1
  let mask = 0x80
  while (mask > 0 && !(firstByte & mask)) {
    width++
    mask >>= 1
  }
  if (width > 8 || offset + width > buf.length) return null
  let value = firstByte & (mask - 1)
  for (let i = 1; i < width; i++) {
    value = (value * 256) + buf[offset + i]
  }
  return { value, width }
}

// ═══════════════════════════════════════════════════════════════════
// MP4 Box Builders
// ═══════════════════════════════════════════════════════════════════

function writeUInt32BE(buf, value, offset) {
  buf[offset] = (value >>> 24) & 0xFF
  buf[offset + 1] = (value >>> 16) & 0xFF
  buf[offset + 2] = (value >>> 8) & 0xFF
  buf[offset + 3] = value & 0xFF
}

function writeUInt16BE(buf, value, offset) {
  buf[offset] = (value >>> 8) & 0xFF
  buf[offset + 1] = value & 0xFF
}

function box(type, ...children) {
  const typeBytes = Buffer.from(type, 'ascii')
  const totalData = Buffer.concat(children.filter(Boolean))
  if (totalData.length + 8 > 0xFFFFFFFF) {
    const header = Buffer.alloc(16)
    writeUInt32BE(header, 1, 0)
    header.set(typeBytes, 4)
    writeUInt32BE(header, 0, 8)
    writeUInt32BE(header, totalData.length + 16, 12)
    return Buffer.concat([header, totalData])
  }
  const header = Buffer.alloc(8)
  writeUInt32BE(header, totalData.length + 8, 0)
  header.set(typeBytes, 4)
  return Buffer.concat([header, totalData])
}

function fullBox(type, version, flags, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const header = Buffer.alloc(12)
  writeUInt32BE(header, data.length + 12, 0)
  header.set(typeBytes, 4)
  writeUInt32BE(header, (version << 24) | (flags & 0xFFFFFF), 8)
  return Buffer.concat([header, data])
}

/** Build ftyp box. */
function buildFtyp() {
  return box('ftyp',
    Buffer.concat([
      Buffer.from('isom', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('isom', 'ascii'),
      Buffer.from('iso2', 'ascii'),
      Buffer.from('avc1', 'ascii'),
      Buffer.from('mp41', 'ascii'),
      Buffer.from('msdh', 'ascii'),
    ])
  )
}

/** Build mvhd (Movie Header Box). */
function buildMvhd(durationTimescale) {
  const data = Buffer.alloc(100)
  data.writeUInt32BE(0, 0)  // version + flags
  writeUInt32BE(data, 1000, 8)   // timescale = 1000
  writeUInt32BE(data, Math.max(1, Math.ceil(durationTimescale / 1000)), 12)
  writeUInt32BE(data, 0x00010000, 16) // rate = 1.0
  data[20] = 0x01  // volume = 1.0
  writeUInt32BE(data, 0x00010000, 32)  // matrix a
  writeUInt32BE(data, 0x00010000, 48)  // matrix d
  writeUInt32BE(data, 0x40000000, 64)  // matrix w
  writeUInt32BE(data, 3, 92)  // next_track_ID
  return fullBox('mvhd', 0, 0, data)
}

/** Build tkhd (Track Header Box). */
function buildTkhd(trackId, duration, isVideo, width, height) {
  const data = Buffer.alloc(80)
  data.writeUInt32BE(0x000001, 0) // flags = track_enabled
  writeUInt32BE(data, trackId, 8)
  writeUInt32BE(data, duration, 16)
  if (!isVideo) data[32] = 0x01  // volume = 1.0 for audio
  writeUInt32BE(data, 0x00010000, 36)
  writeUInt32BE(data, 0x00010000, 52)
  writeUInt32BE(data, 0x40000000, 68)
  if (isVideo) {
    writeUInt32BE(data, (width || 1920) << 16, 72)
    writeUInt32BE(data, (height || 1080) << 16, 76)
  }
  return fullBox('tkhd', 0, 1, data)
}

/** Build mdhd (Media Header Box). */
function buildMdhd(timescale, duration) {
  const data = Buffer.alloc(20)
  data.writeUInt32BE(0, 0)
  writeUInt32BE(data, timescale, 8)
  writeUInt32BE(data, duration, 12)
  writeUInt16BE(data, 0x55C4, 16) // language = und
  writeUInt16BE(data, 0, 18)
  return fullBox('mdhd', 0, 0, data)
}

/** Build hdlr (Handler Reference Box). */
function buildHdlr(handlerType, name) {
  const nameBytes = Buffer.from(name + '\0', 'utf8')
  const data = Buffer.alloc(8 + nameBytes.length)
  data.writeUInt32BE(0, 0)
  data.set(Buffer.from(handlerType, 'ascii'), 4)
  data.set(nameBytes, 8)
  return fullBox('hdlr', 0, 0, data)
}

/** Build vmhd (Video Media Header Box). */
function buildVmhd() {
  const data = Buffer.alloc(8)
  data.writeUInt32BE(1, 0)
  return fullBox('vmhd', 0, 1, data)
}

/** Build smhd (Sound Media Header Box). */
function buildSmhd() {
  const data = Buffer.alloc(4)
  return fullBox('smhd', 0, 0, data)
}

/** Build dinf + dref boxes. */
function buildDinf() {
  const urlBox = fullBox('url ', 0, 1, Buffer.alloc(0))
  return box('dinf',
    fullBox('dref', 0, 0,
      Buffer.concat([
        Buffer.from([0, 0, 0, 1]),
        urlBox,
      ])
    )
  )
}

/** Build avc1 sample entry (H.264 video). */
function buildAvc1(width, height, avcCData) {
  const w = width || 1920
  const h = height || 1080
  const sampleEntry = Buffer.alloc(78)
  writeUInt16BE(sampleEntry, 1, 6)
  writeUInt16BE(sampleEntry, w, 24)
  writeUInt16BE(sampleEntry, h, 26)
  writeUInt32BE(sampleEntry, 0x00480000, 28)
  writeUInt32BE(sampleEntry, 0x00480000, 32)
  writeUInt16BE(sampleEntry, 1, 40)
  writeUInt16BE(sampleEntry, 0x0018, 74)
  writeUInt16BE(sampleEntry, -1 & 0xFFFF, 76)
  const avcCBox = box('avcC', avcCData)
  return box('avc1', sampleEntry, avcCBox)
}

/** Build mp4a sample entry (AAC audio). */
function buildMp4a(sampleRate, channels, esdsData) {
  const sr = sampleRate || 44100
  const ch = channels || 2
  const sampleEntry = Buffer.alloc(28)
  writeUInt16BE(sampleEntry, 1, 6)
  writeUInt16BE(sampleEntry, ch, 16)
  writeUInt16BE(sampleEntry, 16, 18)
  writeUInt32BE(sampleEntry, sr << 16, 24)
  const esdsBox = fullBox('esds', 0, 0, esdsData)
  return box('mp4a', sampleEntry, esdsBox)
}

/**
 * Build ESDS (Elementary Stream Descriptor) from AAC AudioSpecificConfig.
 */
function buildEsds(audioSpecificConfig, sampleRate, channels) {
  const sr = sampleRate || 44100
  const ch = channels || 2
  const srMap = {
    96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4,
    32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9,
    11025: 10, 8000: 11, 7350: 12,
  }
  const srIdx = srMap[sr] ?? 4
  let asc
  if (audioSpecificConfig && audioSpecificConfig.length >= 2) {
    asc = audioSpecificConfig
  } else {
    asc = Buffer.alloc(2)
    asc[0] = (2 << 3) | (srIdx >> 1)
    asc[1] = ((srIdx & 1) << 7) | (ch << 3)
  }
  const decoderSpecificInfo = mpeg4Tag(0x05, asc)
  const decoderConfigDescriptor = mpeg4Tag(0x04,
    Buffer.concat([
      Buffer.from([0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      decoderSpecificInfo,
    ])
  )
  const slConfigDescriptor = mpeg4Tag(0x06, Buffer.from([0x02]))
  const esDescriptor = mpeg4Tag(0x03,
    Buffer.concat([
      Buffer.from([0x00, 0x01]),
      decoderConfigDescriptor,
      slConfigDescriptor,
    ])
  )
  return esDescriptor
}

/** Helper: Build an MPEG-4 descriptor tag. */
function mpeg4Tag(id, content) {
  const sizeBytes = []
  let size = content.length
  do {
    sizeBytes.unshift(size & 0x7F)
    size >>= 7
  } while (size > 0)
  for (let i = 0; i < sizeBytes.length - 1; i++) {
    sizeBytes[i] |= 0x80
  }
  return Buffer.concat([Buffer.from([id]), Buffer.from(sizeBytes), content])
}

/** Build stsd (Sample Description Box). */
function buildStsd(sampleEntry) {
  const countBuf = Buffer.alloc(4)
  writeUInt32BE(countBuf, 1, 0)
  return fullBox('stsd', 0, 0, Buffer.concat([countBuf, sampleEntry]))
}

/** Build empty stbl (Sample Table Box) for fMP4. */
function buildStbl(sampleEntry) {
  const stsd = buildStsd(sampleEntry)
  const stts = fullBox('stts', 0, 0, Buffer.from([0, 0, 0, 0]))
  const stsc = fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 0]))
  const stsz = fullBox('stsz', 0, 0, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))
  const stco = fullBox('stco', 0, 0, Buffer.from([0, 0, 0, 0]))
  return box('stbl', stsd, stts, stsc, stsz, stco)
}

/** Build a complete moov box. */
function buildMoov(videoTrack, audioTrack, durationMs) {
  const mvhd = buildMvhd(durationMs)
  const tracks = []

  if (videoTrack) {
    const vTrackId = 1
    const vTimescale = videoTrack.timescale || 24000
    const vDuration = Math.ceil((durationMs / 1000) * vTimescale)
    const vSampleEntry = buildAvc1(videoTrack.width, videoTrack.height, videoTrack.codecPrivate)
    const vStbl = buildStbl(vSampleEntry)
    const vTrak = box('trak',
      buildTkhd(vTrackId, vDuration, true, videoTrack.width, videoTrack.height),
      box('mdia',
        buildMdhd(vTimescale, vDuration),
        buildHdlr('vide', 'VideoHandler'),
        box('minf', buildVmhd(), buildDinf(), vStbl)
      )
    )
    tracks.push(vTrak)
  }

  if (audioTrack) {
    const aTrackId = videoTrack ? 2 : 1
    const aTimescale = audioTrack.sampleRate || 44100
    const aDuration = Math.ceil((durationMs / 1000) * aTimescale)
    const aEsds = buildEsds(audioTrack.codecPrivate, audioTrack.sampleRate, audioTrack.channels)
    const aSampleEntry = buildMp4a(audioTrack.sampleRate, audioTrack.channels, aEsds)
    const aStbl = buildStbl(aSampleEntry)
    const aTrak = box('trak',
      buildTkhd(aTrackId, aDuration, false),
      box('mdia',
        buildMdhd(aTimescale, aDuration),
        buildHdlr('soun', 'SoundHandler'),
        box('minf', buildSmhd(), buildDinf(), aStbl)
      )
    )
    tracks.push(aTrak)
  }

  return box('moov', mvhd, ...tracks)
}

// ═══════════════════════════════════════════════════════════════════
// fMP4 Fragment Builder
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a moof+mdat fragment pair.
 */
function buildFragment(sequenceNumber, tracks) {
  const trafBuffers = []
  const mdatBuffers = []

  // mfhd
  const mfhdData = Buffer.alloc(4)
  writeUInt32BE(mfhdData, sequenceNumber, 0)
  const mfhd = fullBox('mfhd', 0, 0, mfhdData)
  trafBuffers.push(mfhd)

  for (const track of tracks) {
    const { trackId, baseMediaDecodeTime, samples, data } = track
    if (!samples || samples.length === 0) continue

    // tfhd with base_data_offset
    const tfhdData = Buffer.alloc(16)
    writeUInt32BE(tfhdData, trackId, 0)
    // base_data_offset will be filled later (bytes 4-11)
    // default_sample_duration (bytes 12-15) — not used, we set per-sample
    const tfhd = fullBox('tfhd', 0, 0x01, tfhdData)

    // tfdt (version 1 for 64-bit)
    const tfdtData = Buffer.alloc(8)
    writeUInt32BE(tfdtData, 0, 0) // high 32 bits
    writeUInt32BE(tfdtData, baseMediaDecodeTime >>> 0, 4) // low 32 bits
    const tfdt = fullBox('tfdt', 1, 0, tfdtData)

    // trun
    const sampleCount = samples.length
    const trunFlags = 0x01 | 0x100 | 0x200 | 0x400 // data_offset + duration + size + flags
    const trunDataSize = 4 + (sampleCount * 16) // 4 for count + 16 per sample (offset+duration+size+flags)
    const trunData = Buffer.alloc(trunDataSize)
    let off = 0
    writeUInt32BE(trunData, sampleCount, off); off += 4

    for (let i = 0; i < sampleCount; i++) {
      const s = samples[i]
      writeUInt32BE(trunData, i === 0 ? 0 : 0, off); off += 4 // data_offset (only first matters)
      writeUInt32BE(trunData, s.duration, off); off += 4
      writeUInt32BE(trunData, s.size, off); off += 4
      const flags = s.isKeyframe ? 0x02000000 : 0x01010000
      writeUInt32BE(trunData, flags, off); off += 4
    }

    const trun = fullBox('trun', 0, trunFlags, trunData)

    const traf = box('traf', tfhd, tfdt, trun)
    trafBuffers.push(traf)

    if (data && data.length > 0) {
      mdatBuffers.push(data)
    }
  }

  const moof = box('moof', ...trafBuffers)

  // Fix up data_offset values in trun boxes
  // The first sample's data_offset should point past the moof box
  // We need to find the trun data_offset field and set it
  let moofScanOffset = 0
  while (moofScanOffset < moof.length - 12) {
    const boxSize = moof.readUInt32BE(moofScanOffset)
    const boxType = moof.subarray(moofScanOffset + 4, moofScanOffset + 8).toString('ascii')
    if (boxType === 'moof' || boxType === 'traf') {
      moofScanOffset += 8 // skip container headers
      continue
    }
    if (boxType === 'trun') {
      // Found trun — update first sample's data_offset
      const trunHeaderOffset = moofScanOffset
      const versionFlags = moof.readUInt32BE(trunHeaderOffset + 8)
      const flags = versionFlags & 0xFFFFFF
      const hasDataOffset = (flags & 0x01) !== 0
      if (hasDataOffset) {
        // data_offset is after sample_count, for the first sample
        const dataOffsetPos = trunHeaderOffset + 16 // fullbox header (12) + sample_count (4)
        writeUInt32BE(moof, moof.length, dataOffsetPos)
      }
      break
    }
    moofScanOffset += boxSize
  }

  const mdatData = Buffer.concat(mdatBuffers)
  const mdat = box('mdat', mdatData)

  return Buffer.concat([moof, mdat])
}

// ═══════════════════════════════════════════════════════════════════
// MKV Remuxer Transform Stream
// ═══════════════════════════════════════════════════════════════════

export class MkvRemuxStream extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: false, writableObjectMode: false })
    this.buffer = Buffer.alloc(0)
    this.headerEmitted = false
    this.clusterTimecode = 0
    this.currentClusterSamples = { video: [], audio: [] }
    this.currentClusterData = { video: [], audio: [] }
    this.sequenceNumber = 0
    this.timecodeScale = 1000000
    this.durationNs = 0
    this.tracks = new Map()
    this.videoTrack = null
    this.audioTrack = null
    this.videoDecodeTime = 0
    this.audioDecodeTime = 0
    this.headerDone = false

    // Parsing state — tracks our position in the MKV hierarchy
    // Level 0: top-level (EBML header, Segment)
    // Level 1: Segment children (Info, Tracks, Clusters)
    // Level 2: Cluster children (Timecode, SimpleBlock, BlockGroup)
    this.inSegment = false
    this.inCluster = false
    this.segmentRemaining = -1 // bytes remaining in Segment (-1 = unknown)
  }

  _transform(chunk, encoding, callback) {
    try {
      this.feed(chunk)
      callback()
    } catch (err) {
      callback(err)
    }
  }

  _flush(callback) {
    try {
      this.flushCluster()
      callback()
    } catch (err) {
      callback(err)
    }
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.processBuffer()
  }

  processBuffer() {
    let progress = true
    while (progress && this.buffer.length > 0) {
      progress = false

      if (!this.inSegment) {
        // Looking for top-level elements (EBML header or Segment)
        const consumed = this.parseTopLevel()
        if (consumed > 0) { progress = true; this.buffer = this.buffer.subarray(consumed) }
      } else if (!this.headerDone) {
        // Inside Segment but haven't finished header — parse Info/Tracks
        const consumed = this.parseSegmentChild()
        if (consumed > 0) { progress = true; this.buffer = this.buffer.subarray(consumed) }
      } else if (this.inCluster) {
        // Inside a Cluster — parse timecode and blocks
        const consumed = this.parseClusterChild()
        if (consumed > 0) { progress = true; this.buffer = this.buffer.subarray(consumed) }
      } else {
        // Header done, looking for Clusters
        const consumed = this.parseSegmentChild()
        if (consumed > 0) { progress = true; this.buffer = this.buffer.subarray(consumed) }
      }
    }
  }

  /**
   * Parse top-level elements (EBML Header or Segment).
   * Returns bytes consumed, or 0 if we need more data.
   */
  parseTopLevel() {
    const idResult = readVINT_ID(this.buffer, 0)
    if (!idResult) return 0
    const sizeResult = readVINT_SIZE(this.buffer, idResult.width)
    if (!sizeResult) return 0

    const headerSize = idResult.width + sizeResult.width
    const dataSize = sizeResult.value

    if (idResult.value === EBML_HEADER) {
      // Skip EBML header
      if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
      return headerSize + dataSize
    }

    if (idResult.value === SEGMENT) {
      // Enter the Segment
      this.inSegment = true
      if (dataSize === -1) {
        this.segmentRemaining = -1 // unknown size
        return headerSize // consume just the header
      }
      this.segmentRemaining = dataSize
      return headerSize
    }

    // Unknown top-level element — skip
    if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
    return headerSize + dataSize
  }

  /**
   * Parse a child element of the Segment.
   * Returns bytes consumed, or 0 if we need more data.
   */
  parseSegmentChild() {
    const idResult = readVINT_ID(this.buffer, 0)
    if (!idResult) return 0
    const sizeResult = readVINT_SIZE(this.buffer, idResult.width)
    if (!sizeResult) return 0

    const headerSize = idResult.width + sizeResult.width
    const dataSize = sizeResult.value

    if (idResult.value === INFO) {
      if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
      const elementData = this.buffer.subarray(headerSize, headerSize + dataSize)
      this.parseInfo(elementData)
      const consumed = headerSize + dataSize
      if (this.segmentRemaining !== -1) this.segmentRemaining -= consumed
      return consumed
    }

    if (idResult.value === TRACKS) {
      if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
      const elementData = this.buffer.subarray(headerSize, headerSize + dataSize)
      this.parseTracks(elementData)
      const consumed = headerSize + dataSize
      if (this.segmentRemaining !== -1) this.segmentRemaining -= consumed

      // If we now have track info and haven't emitted the header yet, do so
      if (this.tracks.size > 0 && !this.headerDone) {
        this.headerDone = true
        this.emitHeader()
      }
      return consumed
    }

    if (idResult.value === CLUSTER) {
      if (dataSize === -1) {
        // Unknown cluster size — enter the cluster and read until next cluster
        this.inCluster = true
        this.clusterTimecode = 0
        const consumed = headerSize
        if (this.segmentRemaining !== -1) this.segmentRemaining -= consumed
        return consumed
      }
      // Known-size cluster — enter it
      this.inCluster = true
      this.clusterTimecode = 0
      // We don't consume the whole cluster at once; we parse its children
      // Just consume the header and let parseClusterChild handle the rest
      // But we need to track cluster end position
      this._clusterEndOffset = headerSize + dataSize // relative to current buffer position
      const consumed = headerSize
      if (this.segmentRemaining !== -1) this.segmentRemaining -= consumed
      return consumed
    }

    // Skip other Segment children (SeekHead, Cues, Tags, etc.)
    if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
    const consumed = headerSize + dataSize
    if (this.segmentRemaining !== -1) this.segmentRemaining -= consumed
    return consumed
  }

  /**
   * Parse a child element inside a Cluster.
   * Returns bytes consumed, or 0 if we need more data.
   */
  parseClusterChild() {
    const idResult = readVINT_ID(this.buffer, 0)
    if (!idResult) return 0
    const sizeResult = readVINT_SIZE(this.buffer, idResult.width)
    if (!sizeResult) return 0

    const headerSize = idResult.width + sizeResult.width
    const dataSize = sizeResult.value

    // Check if this is actually a new Cluster or another top-level Segment child
    // (This happens when the current cluster has unknown size and we hit the next element)
    if (idResult.value === CLUSTER || idResult.value === INFO || idResult.value === TRACKS) {
      // End of current cluster
      this.flushCluster()
      this.inCluster = false
      // Don't consume — let parseSegmentChild handle this element
      return 0
    }

    if (idResult.value === CLUSTER_TIMECODE) {
      if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
      const elementData = this.buffer.subarray(headerSize, headerSize + dataSize)
      this.clusterTimecode = readUInt(elementData, 0, elementData.length)
      return headerSize + dataSize
    }

    if (idResult.value === SIMPLE_BLOCK) {
      if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
      const elementData = this.buffer.subarray(headerSize, headerSize + dataSize)
      this.parseBlock(elementData, false)
      return headerSize + dataSize
    }

    if (idResult.value === BLOCK_GROUP) {
      if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
      const elementData = this.buffer.subarray(headerSize, headerSize + dataSize)
      this.parseBlockGroup(elementData)
      return headerSize + dataSize
    }

    // Skip other cluster children (Position, PrevSize, etc.)
    if (dataSize === -1 || headerSize + dataSize > this.buffer.length) return 0
    return headerSize + dataSize
  }

  parseInfo(data) {
    let offset = 0
    while (offset < data.length) {
      const idResult = readVINT_ID(data, offset)
      if (!idResult) break
      const sizeResult = readVINT_SIZE(data, offset + idResult.width)
      if (!sizeResult) break
      const headerSize = idResult.width + sizeResult.width
      const dataSize = sizeResult.value
      if (dataSize === -1 || offset + headerSize + dataSize > data.length) break
      const elementData = data.subarray(offset + headerSize, offset + headerSize + dataSize)

      if (idResult.value === TIMECODE_SCALE_ID) {
        this.timecodeScale = readUInt(elementData, 0, elementData.length)
      }
      if (idResult.value === DURATION_ID) {
        if (elementData.length === 4) {
          this.durationNs = elementData.readFloatBE(0) * this.timecodeScale
        } else if (elementData.length === 8) {
          this.durationNs = elementData.readDoubleBE(0) * this.timecodeScale
        }
      }
      offset += headerSize + dataSize
    }
  }

  parseTracks(data) {
    let offset = 0
    while (offset < data.length) {
      const idResult = readVINT_ID(data, offset)
      if (!idResult) break
      const sizeResult = readVINT_SIZE(data, offset + idResult.width)
      if (!sizeResult) break
      const headerSize = idResult.width + sizeResult.width
      const dataSize = sizeResult.value
      if (dataSize === -1 || offset + headerSize + dataSize > data.length) break

      if (idResult.value === TRACK_ENTRY) {
        const elementData = data.subarray(offset + headerSize, offset + headerSize + dataSize)
        const track = this.parseTrackEntry(elementData)
        if (track) {
          this.tracks.set(track.trackNumber, track)
          if (track.trackType === TRACK_TYPE_VIDEO && !this.videoTrack) {
            this.videoTrack = track
          } else if (track.trackType === TRACK_TYPE_AUDIO && !this.audioTrack) {
            this.audioTrack = track
          }
        }
      }
      offset += headerSize + dataSize
    }
  }

  parseTrackEntry(data) {
    const track = {
      trackNumber: 0, trackUid: 0, trackType: 0,
      codecId: '', codecPrivate: null, defaultDuration: 0,
      width: 0, height: 0, sampleRate: 44100, channels: 2, bitDepth: 16,
    }

    let offset = 0
    while (offset < data.length) {
      const idResult = readVINT_ID(data, offset)
      if (!idResult) break
      const sizeResult = readVINT_SIZE(data, offset + idResult.width)
      if (!sizeResult) break
      const headerSize = idResult.width + sizeResult.width
      const dataSize = sizeResult.value
      if (dataSize === -1 || offset + headerSize + dataSize > data.length) break
      const elementData = data.subarray(offset + headerSize, offset + headerSize + dataSize)

      switch (idResult.value) {
        case TRACK_NUMBER:
          track.trackNumber = readUInt(elementData, 0, elementData.length)
          break
        case TRACK_UID:
          track.trackUid = readUInt(elementData, 0, elementData.length)
          break
        case TRACK_TYPE:
          track.trackType = readUInt(elementData, 0, elementData.length)
          break
        case CODEC_ID:
          track.codecId = elementData.toString('ascii')
          break
        case CODEC_PRIVATE:
          track.codecPrivate = Buffer.from(elementData)
          break
        case DEFAULT_DURATION:
          track.defaultDuration = readUInt(elementData, 0, elementData.length)
          break
        case VIDEO_SETTINGS: {
          let vOff = 0
          while (vOff < elementData.length) {
            const vId = readVINT_ID(elementData, vOff)
            if (!vId) break
            const vSz = readVINT_SIZE(elementData, vOff + vId.width)
            if (!vSz) break
            const vHS = vId.width + vSz.width
            const vDS = vSz.value
            if (vDS === -1 || vOff + vHS + vDS > elementData.length) break
            const vData = elementData.subarray(vOff + vHS, vOff + vHS + vDS)
            if (vId.value === PIXEL_WIDTH) track.width = readUInt(vData, 0, vData.length)
            if (vId.value === PIXEL_HEIGHT) track.height = readUInt(vData, 0, vData.length)
            vOff += vHS + vDS
          }
          break
        }
        case AUDIO_SETTINGS: {
          let aOff = 0
          while (aOff < elementData.length) {
            const aId = readVINT_ID(elementData, aOff)
            if (!aId) break
            const aSz = readVINT_SIZE(elementData, aOff + aId.width)
            if (!aSz) break
            const aHS = aId.width + aSz.width
            const aDS = aSz.value
            if (aDS === -1 || aOff + aHS + aDS > elementData.length) break
            const aData = elementData.subarray(aOff + aHS, aOff + aHS + aDS)
            if (aId.value === SAMPLING_FREQUENCY) {
              if (aData.length <= 4) track.sampleRate = readUInt(aData, 0, aData.length)
              else track.sampleRate = Math.round(aData.readDoubleBE(0))
            }
            if (aId.value === CHANNELS) track.channels = readUInt(aData, 0, aData.length)
            if (aId.value === BIT_DEPTH) track.bitDepth = readUInt(aData, 0, aData.length)
            aOff += aHS + aDS
          }
          break
        }
      }
      offset += headerSize + dataSize
    }

    // Only return tracks with supported codecs
    if (track.trackType === TRACK_TYPE_VIDEO) {
      if (track.codecId === 'V_MPEG4/ISO/AVC' || track.codecId === 'V_MPEGH/ISO/HEVC') return track
      return null
    }
    if (track.trackType === TRACK_TYPE_AUDIO) {
      if (track.codecId.startsWith('A_AAC') || track.codecId === 'A_MPEG/L3') return track
      return null
    }
    return null
  }

  emitHeader() {
    const ftyp = buildFtyp()
    const durationMs = this.durationNs / 1e6 || 3600000

    let videoTimescale = 24000
    if (this.videoTrack) {
      if (this.videoTrack.defaultDuration > 0) {
        videoTimescale = Math.round(1e9 / this.videoTrack.defaultDuration)
      }
      if (!this.videoTrack.codecPrivate || this.videoTrack.codecPrivate.length < 8) {
        this.videoTrack.codecPrivate = Buffer.from([
          0x01, 0x64, 0x00, 0x1F, 0xFF, 0xE1, 0x00, 0x01, 0x67, 0x01, 0x00, 0x01, 0x68,
        ])
      }
    }

    const videoTrackInfo = this.videoTrack ? {
      timescale: videoTimescale,
      width: this.videoTrack.width, height: this.videoTrack.height,
      codecPrivate: this.videoTrack.codecPrivate,
    } : null

    const audioTrackInfo = this.audioTrack ? {
      sampleRate: this.audioTrack.sampleRate, channels: this.audioTrack.channels,
      codecPrivate: this.audioTrack.codecPrivate,
    } : null

    const moov = buildMoov(videoTrackInfo, audioTrackInfo, durationMs)
    this.push(ftyp)
    this.push(moov)
    this.headerEmitted = true
  }

  parseBlockGroup(data) {
    let blockData = null
    let refBlock = false
    let offset = 0
    while (offset < data.length) {
      const bId = readVINT_ID(data, offset)
      if (!bId) break
      const bSz = readVINT_SIZE(data, offset + bId.width)
      if (!bSz) break
      const bHS = bId.width + bSz.width
      const bDS = bSz.value
      if (bDS === -1 || offset + bHS + bDS > data.length) break
      const bData = data.subarray(offset + bHS, offset + bHS + bDS)
      if (bId.value === BLOCK) blockData = bData
      if (bId.value === REFERENCE_BLOCK) refBlock = true
      offset += bHS + bDS
    }
    if (blockData) this.parseBlock(blockData, refBlock)
  }

  parseBlock(data, hasReference) {
    let offset = 0
    const trackResult = readVINT_Value(data, offset)
    if (!trackResult) return
    const trackNumber = trackResult.value
    offset += trackResult.width

    if (offset + 2 > data.length) return
    const blockTimecode = readInt(data, offset, 2)
    offset += 2

    if (offset + 1 > data.length) return
    const flags = data[offset]
    offset += 1

    const isKeyframe = (flags & 0x80) !== 0
    const lacing = (flags >> 1) & 0x03

    const track = this.tracks.get(trackNumber)
    if (!track) return

    if (lacing === 0) {
      const frameData = data.subarray(offset)
      this.addFrame(track, frameData, blockTimecode, isKeyframe, hasReference)
    } else if (lacing === 2) {
      if (offset >= data.length) return
      const laceCount = data[offset] + 1
      offset += 1
      const frameSize = Math.floor((data.length - offset) / laceCount)
      for (let i = 0; i < laceCount; i++) {
        const frameData = data.subarray(offset + i * frameSize, offset + (i + 1) * frameSize)
        this.addFrame(track, frameData, blockTimecode + i, i === 0 ? isKeyframe : !hasReference, hasReference)
      }
    } else if (lacing === 3) {
      if (offset >= data.length) return
      const laceCount = data[offset] + 1
      offset += 1
      const sizes = []
      let size = 0
      for (let i = 0; i < laceCount - 1; i++) {
        const vintResult = readVINT_Value(data, offset)
        if (!vintResult) return
        offset += vintResult.width
        if (i === 0) {
          size = vintResult.value
        } else {
          const bits = vintResult.width * 7
          const half = 1 << (bits - 1)
          size += vintResult.value - half
        }
        sizes.push(Math.max(0, size))
      }
      const remaining = data.length - offset - sizes.reduce((a, b) => a + b, 0)
      sizes.push(Math.max(0, remaining))
      let frameOffset = offset
      for (let i = 0; i < laceCount; i++) {
        const frameData = data.subarray(frameOffset, frameOffset + sizes[i])
        this.addFrame(track, frameData, blockTimecode + i, i === 0 ? isKeyframe : !hasReference, hasReference)
        frameOffset += sizes[i]
      }
    } else if (lacing === 1) {
      if (offset >= data.length) return
      const laceCount = data[offset] + 1
      offset += 1
      const sizes = []
      for (let i = 0; i < laceCount - 1; i++) {
        let sz = 0
        while (offset < data.length) {
          const byte = data[offset++]
          sz += byte
          if (byte < 255) break
        }
        sizes.push(sz)
      }
      const remaining = data.length - offset - sizes.reduce((a, b) => a + b, 0)
      sizes.push(Math.max(0, remaining))
      let frameOffset = offset
      for (let i = 0; i < laceCount; i++) {
        const frameData = data.subarray(frameOffset, frameOffset + sizes[i])
        this.addFrame(track, frameData, blockTimecode + i, i === 0 ? isKeyframe : !hasReference, hasReference)
        frameOffset += sizes[i]
      }
    }
  }

  addFrame(track, frameData, blockTimecode, isKeyframe, hasReference) {
    const absoluteTimecode = this.clusterTimecode + blockTimecode

    if (track.trackType === TRACK_TYPE_VIDEO && this.videoTrack) {
      const timescale = Math.round(1e9 / (track.defaultDuration || (this.timecodeScale * 24))) || 24000
      const decodeTime = Math.round((absoluteTimecode * this.timecodeScale * timescale) / 1e9)
      const duration = Math.max(1, Math.round((track.defaultDuration || (1e9 / timescale)) * timescale / 1e9))

      this.currentClusterSamples.video.push({
        duration, size: frameData.length,
        isKeyframe: isKeyframe && !hasReference, decodeTime,
      })
      this.currentClusterData.video.push(Buffer.from(frameData))
    } else if (track.trackType === TRACK_TYPE_AUDIO && this.audioTrack) {
      const timescale = track.sampleRate || 44100
      const duration = 1024 // AAC frames = 1024 samples
      const decodeTime = Math.round((absoluteTimecode * this.timecodeScale * timescale) / 1e9)

      this.currentClusterSamples.audio.push({
        duration, size: frameData.length,
        isKeyframe: true, decodeTime,
      })
      this.currentClusterData.audio.push(Buffer.from(frameData))
    }
  }

  flushCluster() {
    if (!this.headerEmitted) return
    if (this.currentClusterSamples.video.length === 0 && this.currentClusterSamples.audio.length === 0) return

    this.sequenceNumber++
    const fragmentTracks = []

    if (this.currentClusterSamples.video.length > 0 && this.videoTrack) {
      fragmentTracks.push({
        trackId: 1,
        baseMediaDecodeTime: this.videoDecodeTime,
        samples: this.currentClusterSamples.video,
        data: Buffer.concat(this.currentClusterData.video),
      })
      const lastSample = this.currentClusterSamples.video[this.currentClusterSamples.video.length - 1]
      this.videoDecodeTime = lastSample.decodeTime + lastSample.duration
    }

    if (this.currentClusterSamples.audio.length > 0 && this.audioTrack) {
      fragmentTracks.push({
        trackId: this.videoTrack ? 2 : 1,
        baseMediaDecodeTime: this.audioDecodeTime,
        samples: this.currentClusterSamples.audio,
        data: Buffer.concat(this.currentClusterData.audio),
      })
      const lastSample = this.currentClusterSamples.audio[this.currentClusterSamples.audio.length - 1]
      this.audioDecodeTime = lastSample.decodeTime + lastSample.duration
    }

    const fragment = buildFragment(this.sequenceNumber, fragmentTracks)
    this.push(fragment)

    this.currentClusterSamples = { video: [], audio: [] }
    this.currentClusterData = { video: [], audio: [] }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Convenience functions
// ═══════════════════════════════════════════════════════════════════

export function mkvToMp4() {
  return new MkvRemuxStream()
}

export function isMkvContentType(contentType) {
  if (!contentType) return false
  return /video\/x-matroska|video\/matroska|audio\/x-matroska/i.test(contentType)
}

export function isMkvUrl(url) {
  if (!url) return false
  // .mkv file extension or -mkv suffix (NetNaija CDN uses /filename-mkv pattern)
  return /\.mkv(\?|#|$)/i.test(url) || /-mkv(\?|#|$)/i.test(url)
}
