# Chan Platform - User Journey & Architecture

## 🎬 User Journey Flow

```mermaid
graph TD
    Start([User Lands on chan-yz3p.vercel.app]) --> Auth{Authenticated?}
    Auth -->|No| LoginPage[Login Page]
    Auth -->|Yes| HomePage[Home Page]
    
    LoginPage --> AuthMethod{Choose Method}
    AuthMethod -->|Anonymous| AnonymousAuth[Firebase Anonymous Auth]
    AuthMethod -->|Google| GoogleAuth[Google OAuth]
    AnonymousAuth --> HomePage
    GoogleAuth --> HomePage
    
    HomePage --> Action{What Next?}
    Action -->|Join Room| JoinRoom[Enter Room Code]
    Action -->|Create Room| CreateRoom[Create Room Page]
    Action -->|Browse| SearchPage[Search Page]
    
    JoinRoom --> RoomJoin[Join Existing Room]
    RoomJoin --> VideoSync[Video Playback Sync]
    
    CreateRoom --> RoomSetup[Configure Room]
    RoomSetup --> ContentSource{Choose Content}
    
    ContentSource -->|YouTube| YTSearch[Search YouTube]
    ContentSource -->|Direct URL| DirectURL[Paste Video URL]
    ContentSource -->|Search| UnifiedSearch[Unified Search]
    
    YTSearch --> SelectVideo[Select Video]
    DirectURL --> ValidateURL[Validate URL]
    UnifiedSearch --> SearchLayer{Select Layer}
    
    SearchLayer -->|All| AllSearch[Multi-Source Search]
    SearchLayer -->|YouTube| YTSearch2[YouTube Only]
    SearchLayer -->|Direct| DirectSearch[O2TV/Nkiri Search]
    SearchLayer -->|IPTV| IPTVSearch[Live TV Search]
    SearchLayer -->|Sports| SportsSearch[Sports Search]
    
    AllSearch --> DisplayResults[Display Results]
    YTSearch2 --> DisplayResults
    DirectSearch --> DisplayResults
    IPTVSearch --> DisplayResults
    SportsSearch --> DisplayResults
    
    DisplayResults --> ClickResult[Click Result]
    ClickResult --> ResolveMedia{Need Resolution?}
    
    ResolveMedia -->|No| DirectPlay[Direct Playback URL]
    ResolveMedia -->|Yes| ServerResolve[Server Resolution]
    
    ServerResolve --> Provider{Provider Type}
    Provider -->|O2TV| O2TVFlow[Season → Episode → CDN]
    Provider -->|Nkiri| NkiriFlow[Episode Scraping]
    Provider -->|MKV| MKVRemux[MKV → fMP4 Remux]
    Provider -->|HLS| HLSProxy[HLS Proxy]
    
    O2TVFlow --> GetPlayableURL[Get Playable URL]
    NkiriFlow --> GetPlayableURL
    MKVRemux --> GetPlayableURL
    HLSProxy --> GetPlayableURL
    
    DirectPlay --> RoomVideo[Room Video Player]
    GetPlayableURL --> RoomVideo
    
    ValidateURL --> RoomSetup2[Room Setup]
    SelectVideo --> RoomSetup2
    RoomSetup2 --> InviteUsers[Invite Users]
    InviteUsers --> RoomVideo
    
    VideoSync --> SyncControl{Host Controls}
    RoomVideo --> SyncControl
    
    SyncControl -->|Play/Pause| SyncAll[Sync to All Viewers]
    SyncControl -->|Seek| SyncSeek[Sync Seek Position]
    SyncControl -->|Change Video| ChangeVideo[Update Video]
    
    SyncAll --> VideoSync
    SyncSeek --> VideoSync
    ChangeVideo --> VideoSync
    
    RoomVideo --> Features{Use Features}
    Features -->|Chat| LiveChat[Live Chat]
    Features -->|Screen Share| ScreenShare[WebRTC Screen Share]
    Features -->|AI Subtitles| AISubtitles[Generate Subtitles]
    Features -->|Reactions| LiveReactions[Send Reactions]
    
    LiveChat --> RoomVideo
    ScreenShare --> RoomVideo
    AISubtitles --> RoomVideo
    LiveReactions --> RoomVideo
```

## 🏗️ Platform Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        Browser[Web Browser]
        Android[Android App<br/>Capacitor]
        
        Browser --> ReactApp[React SPA]
        Android --> ReactApp
        
        ReactApp --> Components[UI Components]
        Components --> VideoPlayer[Video Player<br/>hls.js + react-player]
        Components --> ChatUI[Chat Interface]
        Components --> SearchUI[Search Interface]
        Components --> RoomUI[Room Management]
    end
    
    subgraph "Authentication Layer"
        Firebase[ Firebase Auth ]
        Google[Google OAuth]
        Anonymous[Anonymous Auth]
        
        Firebase --> Google
        Firebase --> Anonymous
    end
    
    subgraph "Real-time Sync Layer"
        Firestore[ Firestore ]
        Rooms[Rooms Collection]
        Messages[Messages]
        PlayerState[Player State]
        Participants[Participants]
        
        Firestore --> Rooms
        Rooms --> Messages
        Rooms --> PlayerState
        Rooms --> Participants
    end
    
    subgraph "API Layer - Vercel Serverless"
        Vercel[Vercel Functions<br/>10s timeout]
        
        RoomAPI[/api/room<br/>Room Management]
        MediaAPI[/api/media<br/>Search & Scrape]
        ProxyAPI[/api/proxy<br/>Video Proxy]
        
        Vercel --> RoomAPI
        Vercel --> MediaAPI
        Vercel --> ProxyAPI
    end
    
    subgraph "Server Libraries"
        MKVRemux[MKV Remuxer<br/>HEVC/VP9/AV1]
        O2TVResolver[O2TV Resolver]
        NkiriResolver[Nkiri Scraper]
        HLSParser[HLS Parser]
        SSRF[SSRF Protection]
        RateLimit[Rate Limiting]
        
        MediaAPI --> MKVRemux
        MediaAPI --> O2TVResolver
        MediaAPI --> NkiriResolver
        ProxyAPI --> MKVRemux
        ProxyAPI --> HLSParser
        MediaAPI --> SSRF
        MediaAPI --> RateLimit
    end
    
    subgraph "External Content Sources"
        YouTube[YouTube API]
        O2TV[tvshows4mobile.org]
        Nkiri[thenkiri.com]
        IPTV[IPTV Playlists]
        SportsAPI[Football Data API]
        OMDB[OMDB API]
    end
    
    subgraph "Video Sources"
        CDN1[CDN Server 1]
        CDN2[CDN Server 2]
        CDN3[CDN Server 3]
        MKVFiles[MKV Files]
        HLSStreams[HLS Streams]
    end
    
    subgraph "Worker Layer - Railway/Render"
        O2TVWorker[O2TV Worker<br/>No timeout limit]
        CaptchaSolver[Captcha Solver]
        GroqAI[Groq AI Vision]
        
        O2TVWorker --> CaptchaSolver
        O2TVWorker --> GroqAI
    end
    
    subgraph "AI Services"
        Groq[Groq API]
        SubtitleGen[Subtitle Generation]
        SceneAnalysis[Scene Analysis]
    end
    
    %% Client connections
    ReactApp -->|Auth| Firebase
    ReactApp -->|Real-time| Firestore
    ReactApp -->|API Calls| Vercel
    VideoPlayer -->|Stream| ProxyAPI
    
    %% API connections
    RoomAPI --> Firestore
    MediaAPI --> YouTube
    MediaAPI --> O2TV
    MediaAPI --> Nkiri
    MediaAPI --> IPTV
    MediaAPI --> SportsAPI
    MediaAPI --> OMDB
    
    %% Proxy connections
    ProxyAPI --> CDN1
    ProxyAPI --> CDN2
    ProxyAPI --> CDN3
    ProxyAPI --> MKVFiles
    ProxyAPI --> HLSStreams
    
    %% Worker connections
    MediaAPI -->|Long tasks| O2TVWorker
    O2TVResolver -->|Offload| O2TVWorker
    O2TVWorker --> O2TV
    O2TVWorker --> Groq
    
    %% AI connections
    RoomAPI --> Groq
    Groq --> SubtitleGen
    Groq --> SceneAnalysis
```

## 🔄 Data Flow: Search & Playback

```mermaid
sequenceDiagram
    participant U as User
    participant C as Client
    participant API as Vercel API
    participant W as O2TV Worker
    participant P as Video Proxy
    participant CDN as CDN Server
    participant FS as Firestore
    
    U->>C: Search "Silo" in Direct Links
    C->>API: POST /api/media<br/>{action: "search", layer: "direct"}
    
    par Parallel Search
        API->>API: searchO2Tv("silo")
        Note over API: Promise.race:<br/>Probe (2s) + Catalog (3s)
        API->>API: probeShowPage("silo")
        API-->>API: Found: /silo/
    end
    
    API-->>C: Results: [{title: "Silo", url: "...", showSlug: "silo"}]
    C-->>U: Display search results
    
    U->>C: Click "Silo" result
    C->>C: handleResultSelect()
    C->>C: Navigate to /create?showSlug=silo
    
    Note over C: CreateRoomPage detects showSlug
    C->>API: POST /api/media<br/>{action: "o2tvSeasons", showSlug: "silo"}
    API->>API: getO2TvSeasons("silo")
    API->>API: Fetch tvshows4mobile.org/silo/
    API->>API: Parse Season-01, Season-02, Season-03
    API-->>C: Seasons: [{number: 1}, {number: 2}, {number: 3}]
    C-->>U: Display season selection
    
    U->>C: Select Season 1
    C->>API: POST /api/media<br/>{action: "o2tvEpisodes", showSlug: "silo", seasonNum: 1}
    API->>API: getO2TvEpisodes("silo", 1)
    API-->>C: Episodes: [{number: 1, title: "Episode 1"}, ...]
    C-->>U: Display episode list
    
    U->>C: Select Episode 1
    C->>API: POST /api/media<br/>{action: "o2tvResolve", showSlug: "silo", seasonNum: 1, episodeNum: 1}
    
    alt Vercel timeout likely
        API->>W: POST /resolve-episode
        W->>W: Fetch episode page
        W->>W: Solve captcha (Groq vision)
        W->>W: Extract CDN URL
        W-->>API: {url: "http://d6.o2tv.org/.../S01E01.mp4"}
    else Fast resolution
        API->>API: resolveO2TvEpisode()
        API->>API: Probe CDN URLs
        API->>API: Find working URL
    end
    
    API-->>C: Playable URL: http://d6.o2tv.org/.../S01E01.mp4
    
    C->>C: Create room with video URL
    C->>FS: Create room document
    C->>FS: Set playerState
    C->>FS: Add host as participant
    C-->>U: Room created, navigate to /room/:roomId
    
    Note over U,P: Video Playback Flow
    
    U->>C: Play video
    C->>P: GET /api/proxy?url=http://d6.o2tv.org/.../S01E01.mp4
    
    alt MKV file
        P->>P: Detect MKV container
        P->>P: Remux MKV → fMP4
        Note over P: Support HEVC, VP9, AV1<br/>Opus, AC3, EAC3
        P->>CDN: Fetch MKV data
        CDN-->>P: MKV stream
        P->>P: Convert to fMP4 chunks
        P-->>C: video/mp4 stream
    else MP4 file
        P->>CDN: GET /...S01E01.mp4
        CDN-->>P: MP4 stream
        P-->>C: video/mp4 stream
    else HLS stream
        P->>CDN: GET playlist.m3u8
        CDN-->>P: M3U8 playlist
        P->>P: Rewrite segment URLs
        P-->>C: Modified M3U8
        loop For each segment
            C->>P: GET /api/proxy?url=segment.ts
            P->>CDN: GET segment.ts
            CDN-->>P: TS segment
            P-->>C: TS segment
        end
    end
    
    C->>C: VideoPlayer loads stream
    C-->>U: Video playing
    
    Note over C,FS: Sync Flow
    
    U->>C: Pause video
    C->>FS: Update playerState<br/>{isPlaying: false, currentTime: 45.2}
    FS-->>C: Real-time update to all viewers
    
    loop Every 3 seconds
        C->>FS: Read playerState
        FS-->>C: {isPlaying: false, currentTime: 45.2}
        C->>C: Sync local player
    end
    
    OtherViewers->>FS: Subscribe to playerState
    FS-->>OtherViewers: {isPlaying: false, currentTime: 45.2}
    OtherViewers->>OtherViewers: Sync video to 45.2s, pause
```

## 🏢 Infrastructure Overview

```mermaid
graph TB
    subgraph "User Devices"
        Web[Web Browser<br/>Chrome/Firefox/Safari]
        Mobile[Android App<br/>Capacitor WebView]
    end
    
    subgraph "CDN & Edge"
        VercelEdge[Vercel Edge Network<br/>Global CDN]
    end
    
    subgraph "Vercel Serverless - Hobby Plan"
        direction TB
        FN1[Function: /api/room<br/>256MB, 10s timeout]
        FN2[Function: /api/media<br/>1024MB, 10s timeout]
        FN3[Function: /api/proxy<br/>1024MB, 10s timeout]
        
        Static[Static Assets<br/>React SPA]
    end
    
    subgraph "Firebase - Free Tier"
        direction TB
        Auth[Firebase Auth<br/>Anonymous + Google]
        Firestore[Firebase Firestore<br/>50K reads/day, 20K writes/day]
    end
    
    subgraph "External Workers"
        direction TB
        Railway[O2TV Worker<br/>Railway/Render<br/>No timeout]
    end
    
    subgraph "Third-Party APIs"
        direction TB
        YouTubeAPI[YouTube Data API]
        GroqAPI[Groq AI<br/>Vision + Text]
        OMDbAPI[OMDB API<br/>Movie Metadata]
        FootballAPI[Football Data API<br/>Sports Fixtures]
    end
    
    subgraph "Content Sources"
        direction TB
        O2TV[tvshows4mobile.org<br/>TV Shows]
        Nkiri[thenkiri.com<br/>TV Shows]
        IPTVSources[IPTV Playlists<br/>M3U8]
        VideoCDNs[Video CDNs<br/>MP4/MKV/HLS]
    end
    
    Web -->|HTTPS| VercelEdge
    Mobile -->|HTTPS| VercelEdge
    
    VercelEdge --> Static
    VercelEdge --> FN1
    VercelEdge --> FN2
    VercelEdge --> FN3
    
    FN1 -->|Auth| Auth
    FN1 -->|Real-time| Firestore
    FN2 -->|Auth| Auth
    FN2 -->|Data| Firestore
    FN3 -->|Auth| Auth
    
    FN2 -->|Search| YouTubeAPI
    FN2 -->|Search| O2TV
    FN2 -->|Scrape| Nkiri
    FN2 -->|Channels| IPTVSources
    FN2 -->|Fixtures| FootballAPI
    FN2 -->|Metadata| OMDbAPI
    FN2 -->|Long tasks| Railway
    
    FN3 -->|Proxy| VideoCDNs
    
    Railway -->|Solve| GroqAPI
    Railway -->|Scrape| O2TV
    
    FN1 -->|AI| GroqAPI
    
    Auth -->|Users| Firestore
```

## 📊 Key Metrics & Constraints

| Component | Constraint | Current Usage |
|-----------|-----------|---------------|
| **Vercel Functions** | 10s timeout | O2TV worker offloads long tasks |
| **Vercel Memory** | 1024MB max | Sufficient for MKV remuxing |
| **Firestore Reads** | 50K/day | ~20K/day typical |
| **Firestore Writes** | 20K/day | ~8K/day typical |
| **Firestore Storage** | 1GB | ~200MB used |
| **YouTube API** | 10K units/day | ~2K units/day |
| **Groq AI** | Rate limited | Used for captchas + subtitles |
| **MKV Remux** | 80MB max input | Handles most episodes |
| **Proxy Chunk** | 5MB per request | Streams large files |

## 🔐 Security Layers

```mermaid
graph LR
    A[User Request] --> B{Rate Limiting<br/>IP + UID}
    B -->|Exceeded| C[429 Too Many Requests]
    B -->|OK| D{SSRF Validation<br/>No private IPs}
    D -->|Invalid| E[400 Bad Request]
    D -->|Valid| F{Input Sanitization<br/>XSS Prevention}
    F -->|Malicious| G[Sanitized/Cleaned]
    F -->|Clean| H{Auth Check<br/>Firebase Token}
    H -->|Invalid| I[401 Unauthorized]
    H -->|Valid| J{Permission Check<br/>Firestore Rules}
    J -->|Denied| K[403 Forbidden]
    J -->|Allowed| L[Process Request]
    L --> M[Response]
    
    style C fill:#ff6b6b
    style E fill:#ff6b6b
    style I fill:#ff6b6b
    style K fill:#ff6b6b
    style L fill:#51cf66
    style M fill:#51cf66
```
