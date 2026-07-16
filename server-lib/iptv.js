import { getDb } from './firebaseAdmin.js'

const DEFAULT_PLAYLIST_URL = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'
const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const HEALTH_TIMEOUT_MS = 4000

let playlistCache = { expiresAt: 0, channels: [] }

const BUILTIN_EXTRA_CHANNELS = [
  // General / Movies / Sports / Entertainment / Kids / News
  { name: 'BollyWood Hd', url: 'http://telekomtv-ro.akamaized.net/shls/LIVE$BollywoodHD/247.m3u8/Level(3670016)?start=LIVE&end=END', group: 'Bollywood & Asian', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: '5aab TV', url: 'http://158.69.124.9:1935/5aabtv/5aabtv/playlist.m3u8', group: 'Bollywood & Asian', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: '7S Music', url: 'http://103.199.161.254/Content/7smusic/Live/Channel(7smusic)/index.m3u8', group: 'Music', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'B4U Movies', url: 'http://103.199.161.254/Content/b4umovies/Live/Channel(B4UMovies)/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'B4U Music', url: 'http://103.199.161.254/Content/B4Umusic/Live/Channel(B4Umusic)/index.m3u8', group: 'Music', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'B4U Music 2', url: 'http://103.199.161.254/Content/b4umusic/Live/Channel(B4Umusic)/Stream(01)/index.m3u8', group: 'Music', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'BBC World News', url: 'http://103.199.161.254/Content/bbcworld/Live/Channel(BBCworld)/index.m3u8', group: 'News', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Bollywood Classic', url: 'http://telekomtv-ro.akamaized.net/shls/LIVE$BollywoodClassic/6.m3u8/Level(1677721)?start=LIVE&end=END', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Dil Se', url: 'http://linear07hun-lh.akamaihd.net/i/dilse_1@673921/master.m3u8', group: 'Bollywood & Asian', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Hungama Digital Network', url: 'http://linear07hun-lh.akamaihd.net/i/dilse_1@673921/index_2128_av-p.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Peace TV Bangla', url: 'https://api.visionip.tv/live/ASHTTP/peacetv-peacetv-peacetv-bangla-hsslive-25f-16x9-MB/playlist.m3u8', group: 'Religion', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Star Jalsha', url: 'https://yuppcatchup.akamaized.net/preview/starjalsha/1800.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Colour Bangla', url: 'https://yuppcatchup.akamaized.net/preview/etvbengali/2500.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Bollywood Now', url: 'https://a.jsrdn.com/broadcast/d4dba2e3/+0000/hi/c.m3u8', group: 'Bollywood & Asian', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Shemaroo Bollywood Premier', url: 'https://livechannel.shemaroome.com/linearplayout/bollywood-premier-channel/chunklist_1920x1080_cf.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'NASA', url: 'http://wowza-feed09-nasa.pluto.tv/feed09/ngrp:nasa_all/playlist.m3u8', group: 'Science & Tech', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'EBS KIDS', url: 'http://ebsonair.ebs.co.kr:1935/ebsutablet500k/tablet500k/playlist.m3u8', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'ESPN 2', url: 'https://gma2.blab.email/espn2.m3u8', group: 'Sports', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'ESPN News', url: 'https://gma2.blab.email/espnews.m3u8', group: 'Sports', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'ESPN U', url: 'https://gma2.blab.email/espnu.m3u8', group: 'Sports', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Filmrise Movies', url: 'https://dai2.xumo.com/xumocdn/p=roku/amagi_hls_data_xumo1212A-filmrisefreemovies/CDN/676x540_2500000/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'MGM Scifi', url: 'https://mgm-ssai.akamaized.net/amagi_hls_data_mgmAAAAAA-theworks/CDN/720x404_1425600/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Screamfest', url: 'https://vcnleomarkstudios.teleosmedia.com/stream/leomarkstudios/screamfest/seglist_720p.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Fox Action Movies', url: 'http://104.250.154.42:8080/ZZ_foxaction/ZZ_foxaction.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'American Horrors', url: 'http://170.178.189.66:1935/live/Stream1/playlist.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'HOLLYWOOD', url: 'http://104.250.154.42:8080//ZZ_haolaiwu/ZZ_haolaiwu.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Movies', url: 'http://51.52.156.22:8888/http/009', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Warner TV', url: 'http://104.250.154.42:8080//ZZ_huanadianying/ZZ_huanadianying.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'CARTOON NETWORK', url: 'https://stream.simpaisa.com/pitvlive2/cartoon_360p/playlist.m3u8?checkedby:iptvcat.com', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'NTV (UK Time)', url: 'https://a.jsrdn.com/r-373576a1/publish/22680_3BR3zocwi9/index.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'NTV (US Pacific Time)', url: 'https://a.jsrdn.com/broadcast/22680_3BR3zocwi9/-0800/c.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Ananda TV', url: 'http://appcdn.jagobd.com:1934/c5V6mmMyX7RpbEU9Mi8xNy8yMDEOGIDU6RgzQ6NTAgdEoaeFzbF92YWxIZTO0U0ezN1IzMyfvcGVMZEJCTEFWeVN3PTOmdFsaWRtaW51aiPhnPTI/anandatv.stream/playlist.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Channel 24', url: 'https://edge01.iptv.digijadoo.net/live/channel_24/chunks.m3u8', group: 'News', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Jamuna TV HD 2', url: 'https://edge01.iptv.digijadoo.net/live/jamuna_tv/chunks.m3u8', group: 'News', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Maasranga TV', url: 'https://edge01.iptv.digijadoo.net/live/maasranga/chunks.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Gazi TV', url: 'https://edge01.iptv.digijadoo.net/live/gazi_tv/chunks.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'ETV', url: 'https://edge01.iptv.digijadoo.net/live/ekushey_tv/chunks.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'NTV', url: 'https://edge01.iptv.digijadoo.net/live/ntv/chunks.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Deepto TV', url: 'https://edge01.iptv.digijadoo.net/live/deepto_tv/chunks.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Desh TV', url: 'https://edge01.iptv.digijadoo.net/live/desh_tv/chunks.m3u8', group: 'News', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Duronto TV', url: 'https://edge01.iptv.digijadoo.net/live/duronto_tv/chunks.m3u8', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Nagorik TV', url: 'https://edge01.iptv.digijadoo.net/live/nagorik_tv/chunks.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Star Jalsha Movie', url: 'https://edge01.iptv.digijadoo.net/live/jalsha_movies/chunks.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Nick Bangla', url: 'http://103.115.159.69:25461/live/asifmtbsl/asifmtbsl/87.m3u8', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Nick Sonic Bangla', url: 'https://edge01.iptv.digijadoo.net/live/sonic/chunks.m3u8', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Nick JR.', url: 'https://edge01.iptv.digijadoo.net/live/nick_jr/chunks.m3u8', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Jamuna TV HD', url: 'https://edge01.iptv.digijadoo.net/live/jamuna_tv/chunks.m3u8', group: 'News', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'IN: SONY TV HD (VPN)', url: 'http://216.144.250.174/Sony_TV_HD_02/playlist.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'IN: SONY SAB HD (VPN)', url: 'http://216.144.250.174/S0ny_Sab_HD/playlist.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'IN: SONY MAX HD (VPN)', url: 'http://216.144.250.174/Sony_MaX_HD/playlist.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'UK: SONY MAX 2 (VPN)', url: 'http://216.144.250.174/Sony_MaX_HD_02/playlist.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'IN: SONY MIX (VPN)', url: 'http://216.144.250.174/Sony_Mix_HD/playlist.m3u8', group: 'Music', provider: 'Chan Curated Live TV', isNSFW: false },
  // Sony channels with expired hdnea tokens (exp=1594424839 = June 2020) removed.
  // If valid tokens become available, add them via IPTV_CHANNELS_JSON env var instead.

  { name: 'IN: SONY TV HD', url: 'http://channels.ooguy.com:80/auth?channel=SonyTvHdIndia&type=index.m3u8&authorization=RnJFZUFjQ2VTcw==', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'UK: SONY TV HD', url: 'http://channels.ooguy.com:80/auth?channel=SonyTvHdUk&type=index.m3u8&authorization=RnJFZUFjQ2VTcw==', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'IN: SONY AATH', url: 'http://137.59.155.253:8088/hls/Zee_Cinema.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'USA: SONY TV HD', url: 'http://ok2.se:8000/live/e4f1F1Uvb5cccME2H/7deeF1UDa6PNxFp03/407.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Crime', url: 'http://178.159.5.210:1000/play/SonyCrime/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Action', url: 'http://178.159.5.210:1000/play/Sonyaction/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Action 2', url: 'http://178.159.5.210:1000/play/a03r/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Christmas', url: 'http://178.159.5.210:1000/play/a03s/index.m3u8', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Max', url: 'http://42.98.239.149:9981/stream/channelid/1597286721', group: 'Movies', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Sab', url: 'http://42.98.239.149:9981/stream/channelid/2076489617', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Sony Six', url: 'http://42.98.239.149:9981/stream/channelid/1559351927', group: 'Sports', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'National Geographic', url: 'https://edge01.iptv.digijadoo.net/live/nat_geo_in/chunks.m3u8', group: 'Science & Tech', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'Disney Channel india', url: 'http://45.249.187.238:8081/hls/live0.m3u8', group: 'Kids', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'CARAC1', url: 'http://edge14.vedge.infomaniak.com/livecast/event.stream/playlist.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'CARAC5', url: 'https://edge14.vedge.infomaniak.com/livecast/ik:carac5/playlist.m3u8', group: 'Entertainment', provider: 'Chan Curated Live TV', isNSFW: false },
  { name: 'DMF', url: 'https://d-m-f.iptv-playoutcenter.de/dmf/dmf1/playlist.m3u8', group: 'Music', provider: 'Chan Curated Live TV', isNSFW: false },

  // Adult / XXX 18+ Channels — only included when NSFW_ENABLED=true
  ...(process.env.NSFW_ENABLED === 'true' ? [
  { name: 'Babes', url: 'http://88.212.7.11/live/test_basbes_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Brazzers', url: 'http://88.212.7.11/live/test_brazzers_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Extasy', url: 'http://88.212.7.11/live/test_extasy_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Desire', url: 'http://88.212.7.11/live/test_desire_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Erox', url: 'http://88.212.7.11/live/test_erox_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Eroxxx', url: 'http://88.212.7.11/live/test_eroxxx_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Dorcel', url: 'http://88.212.7.11/live/test_dorcel_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Leo', url: 'http://88.212.7.11/live/test_leo_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Leo Gold', url: 'http://88.212.7.11/live/test_leogold_hd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Reality Kings', url: 'http://88.212.7.11/live/test_realitykings_sd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Dusk', url: 'http://88.212.7.11/live/test_dusk_sd_hevc/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Playboy La', url: 'http://190.11.225.124:5000/live/playboy_hd/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'Babes TV', url: 'https://cdn4.skygo.mn/live/disk1/Babes/HLSv3-FTA/Babes.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  { name: 'PLAYBOY TV', url: 'http://31.148.48.15:80/Playboy_TV/playlist.m3u8', group: 'XXX 18+', provider: 'Chan Curated XXX 18+', isNSFW: true },
  ] : []),
]

function readAttribute(line, name) {
  const match = line.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return match?.[1] || ''
}

function isSupportedStreamUrl(value) {
  if (!value || typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    // Skip well-known non-IPTV hosts
    if (host.includes('youtube.com') || host.includes('youtu.be') || host.includes('twitch.tv')) return false
    // Skip MPD (DASH) — browsers can't play it natively without dash.js
    if (/\.mpd(?:\?|#|$)/i.test(url.pathname + url.search)) return false
    // Skip ellipsis / placeholder URLs
    if (value.includes('...')) return false
    // Skip localhost / loopback / private link-local junk
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false
    // Prefer formats browsers can play (HLS / progressive). Still allow
    // extension-less live paths (common for Akamai/Wowza) — player will try HLS.
    const path = `${url.pathname}${url.search}`.toLowerCase()
    const looksStream =
      /\.m3u8?(?:\?|#|$)/i.test(path)
      || /\.(mp4|ts|mpd)(?:\?|#|$)/i.test(path)
      || /playlist|chunklist|index|live|hls|stream|channel|master/i.test(path)
      || url.port !== '' // many IPTV boxes use host:port/path without extension
    if (!looksStream && !/\//.test(url.pathname.slice(1))) return false
    return true
  } catch {
    return false
  }
}

function normalizeChannel(channel) {
  if (!channel?.name || !isSupportedStreamUrl(channel.url)) return null
  return {
    name: String(channel.name).trim(),
    url: channel.url,
    group: String(channel.group || 'Live TV').trim(),
    country: String(channel.country || '').trim(),
    logo: channel.logo || null,
    provider: String(channel.provider || 'custom').trim(),
    playlistUrl: channel.playlistUrl || null,
    isNSFW: Boolean(channel.isNSFW),
  }
}

export function parseM3U(text, source = {}) {
  const channels = []
  const lines = String(text || '').split(/\r?\n/)
  let metadata = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.toUpperCase().startsWith('#EXTINF')) {
      const comma = line.indexOf(',')
      metadata = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : readAttribute(line, 'tvg-name'),
        group: readAttribute(line, 'group-title') || (source.id?.includes('movies') ? 'Movies' : 'Live TV'),
        country: readAttribute(line, 'tvg-country'),
        logo: readAttribute(line, 'tvg-logo') || null,
        provider: source.provider || 'custom',
        playlistUrl: source.url || null,
        isNSFW: Boolean(source.isNSFW),
      }
      continue
    }

    if (line.startsWith('#')) continue
    if (!metadata) continue

    const channel = normalizeChannel({ ...metadata, url: line })
    if (channel) channels.push(channel)
    metadata = null
  }

  return channels
}

function readPlaylistSources() {
  const raw = process.env.IPTV_PLAYLISTS_JSON
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .filter((source) => source?.enabled !== false && source?.url)
          .map((source, index) => ({
            id: String(source.id || `playlist-${index + 1}`),
            provider: String(source.label || source.id || `playlist-${index + 1}`),
            url: String(source.url),
            isNSFW: Boolean(source.isNSFW),
          }))
      }
    } catch {
      console.error('IPTV_PLAYLISTS_JSON is not valid JSON')
    }
  }

  return [
    {
      id: 'free-tv',
      provider: 'Free-TV IPTV',
      url: process.env.IPTV_PLAYLIST_URL || DEFAULT_PLAYLIST_URL,
    },
    {
      id: 'iptv-org-all',
      provider: 'IPTV.org All',
      url: 'https://iptv-org.github.io/iptv/index.m3u',
    },
    {
      id: 'iptv-org-movies',
      provider: 'IPTV.org Movies',
      url: 'https://iptv-org.github.io/iptv/categories/movies.m3u',
    },
    {
      id: 'iptv-org-entertainment',
      provider: 'IPTV.org Entertainment',
      url: 'https://iptv-org.github.io/iptv/categories/entertainment.m3u',
    },
    {
      id: 'iptv-org-xxx',
      provider: 'IPTV.org XXX 18+',
      url: 'https://iptv-org.github.io/iptv/categories/xxx.m3u',
      isNSFW: true,
    },
    ...(process.env.NSFW_ENABLED === 'true' ? [{
      id: 'iptvmate-xxx',
      provider: 'IPTVMate XXX 18+',
      url: 'https://iptvmate.net/files/xxx.m3u',
      isNSFW: true,
    }] : []),
  ]
}

export function getPlaylistSources() {
  return readPlaylistSources()
}

function parseConfiguredChannels() {
  const raw = process.env.IPTV_CHANNELS_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(normalizeChannel).filter(Boolean) : []
  } catch {
    console.error('IPTV_CHANNELS_JSON is not valid JSON')
    return []
  }
}

async function fetchPlaylist(source) {
  const parsed = new URL(source.url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`IPTV playlist ${source.id} must use HTTP/HTTPS`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Chan IPTV catalog/1.0', Accept: 'application/vnd.apple.mpegurl,text/plain' },
    })
    if (!response.ok) throw new Error(`IPTV playlist returned HTTP ${response.status}`)
    return parseM3U(await response.text(), source)
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`IPTV playlist ${source.id} timed out`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function getPlaylistChannels({ force = false } = {}) {
  if (!force && playlistCache.expiresAt > Date.now()) return [...playlistCache.channels]

  const sources = readPlaylistSources()
  const settled = await Promise.allSettled(sources.map((source) => fetchPlaylist(source)))
  const channels = settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value
    console.error(`IPTV playlist ${sources[index].id} failed:`, result.reason?.message || result.reason)
    return []
  })

  const allChannels = [...channels, ...BUILTIN_EXTRA_CHANNELS.map(normalizeChannel).filter(Boolean)]
  if (!allChannels.length) throw new Error('All IPTV playlists are unavailable or empty')
  const unique = new Map(allChannels.map((channel) => [channel.url, channel]))
  playlistCache = { expiresAt: Date.now() + CACHE_TTL_MS, channels: [...unique.values()] }
  return [...playlistCache.channels]
}

export async function checkIptvChannel(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    // Try GET with Range first — many IPTV servers reject HEAD (405) but
    // also reject small Range requests. A full GET with immediate body cancel
    // is the most reliable probe: if we get headers back with a video content
    // type, the channel is alive.
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Chan IPTV health check/1.0',
          Range: 'bytes=0-0',
          Accept: '*/*',
        },
      })
    } catch (fetchErr) {
      // If Range GET fails, retry without Range
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': 'Chan IPTV health check/1.0' },
        })
      } catch (retryErr) {
        return {
          healthy: false,
          status: 0,
          contentType: '',
          error: retryErr.name === 'AbortError' ? 'timeout' : retryErr.message,
        }
      }
    }

    // If GET returned 405/403, try HEAD as fallback
    if (response.status === 405 || response.status === 403 || response.status === 501) {
      await response.body?.cancel?.()
      try {
        response = await fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': 'Chan IPTV health check/1.0' },
        })
      } catch {
        return { healthy: false, status: 0, contentType: '', error: 'timeout' }
      }
    }

    // Drain the body so the connection closes cleanly
    await response.body?.cancel?.()

    const contentType = response.headers.get('content-type') || ''
    const ct = contentType.toLowerCase()
    // Accept video/mpeg, video/mp2t, application/octet-stream, and m3u8 content types
    // Also accept 200/206 responses that are NOT HTML error pages.
    // Many IPTV playlists return text/plain, audio/x-mpegurl, application/vnd.apple.mpegurl
    // with empty/odd types — treat those as healthy when status is OK.
    const isHtml = ct.includes('text/html')
    const isPlaylistOrVideo = /video\/|mpegurl|x-mpegurl|apple\.mpegurl|octet-stream|mpeg|mp2t|text\/plain|application\/json/i.test(ct)
      || ct === ''
      || /\.m3u8?(?:\?|#|$)/i.test(url)
    const healthy = (response.ok || response.status === 206) && !isHtml && isPlaylistOrVideo
    return {
      healthy,
      status: response.status,
      contentType,
      error: healthy ? null : (isHtml ? 'HTML error page' : `HTTP ${response.status}`),
    }
  } catch (error) {
    return {
      healthy: false,
      status: 0,
      contentType: '',
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function readHealthyCatalog(provider) {
  if (process.env.IPTV_USE_FIRESTORE_CATALOG !== 'true') return []
  try {
    const snap = await getDb()
      .collection('mediaCatalog')
      .doc('iptv')
      .collection('channels')
      .where('healthy', '==', true)
      .limit(2000)
      .get()
    return snap.docs
      .map((doc) => normalizeChannel(doc.data()))
      .filter((channel) => channel && (!provider || channel.provider === provider))
  } catch (error) {
    console.error('IPTV Firestore catalog read failed:', error.message)
    return []
  }
}

export async function getIptvChannels(extraChannels = [], provider = '') {
  const configured = [
    ...BUILTIN_EXTRA_CHANNELS.map(normalizeChannel).filter(Boolean),
    ...parseConfiguredChannels(),
    ...extraChannels.map(normalizeChannel).filter(Boolean),
  ]
  const catalog = await readHealthyCatalog(provider)
  if (catalog.length) {
    const unique = new Map([...catalog, ...configured].map((channel) => [channel.url, channel]))
    return [...unique.values()]
      .filter((channel) => !provider || channel.provider === provider || channel.provider === 'Chan Curated Live TV' || channel.provider === 'Chan Curated XXX 18+' || channel.provider === 'custom')
      // Filter out channels marked as unhealthy in the catalog
      .filter((channel) => channel.healthy !== false)
  }

  try {
    const playlistChannels = await getPlaylistChannels()
    const unique = new Map([...playlistChannels, ...configured].map((channel) => [channel.url, channel]))
    return [...unique.values()]
      .filter((channel) => !provider || channel.provider === provider || channel.provider === 'Chan Curated Live TV' || channel.provider === 'Chan Curated XXX 18+' || channel.provider === 'custom')
  } catch (error) {
    console.error('IPTV playlist error:', error.message)
    if (configured.length) return configured.filter((channel) => !provider || channel.provider === provider || channel.provider === 'Chan Curated Live TV' || channel.provider === 'Chan Curated XXX 18+' || channel.provider === 'custom')
    throw Object.assign(new Error('IPTV playlist is currently unavailable'), { status: 503 })
  }
}

/**
 * Quick health probe for a single IPTV channel URL.
 * Used by the room/player to verify a channel is alive before attempting playback.
 * Returns { healthy, contentType, error }.
 */
export async function probeIptvChannel(url) {
  return checkIptvChannel(url)
}
