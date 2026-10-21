import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Compass, PlayCircle, Link2, Tv, Trophy, ShieldAlert,
  Search, X, Loader2, Film, AlertCircle, ChevronRight, Lock,
} from 'lucide-react';
import { useUnifiedSearch } from '../../hooks/useUnifiedSearch';
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx';
import { isDirectVideoUrl, normalizePlaybackUrl } from '../../shared/lib/youtube.js';
import { Modal, Button, useToast } from '../../shared/ui/index.js';
import { ShowBrowser } from '../../shared/components/ShowBrowser.jsx';
import { cleanMediaTitle } from '../../shared/lib/titleFormat.js';
import { apiPath, parseJsonResponse } from '../../shared/lib/api.js';
import { BottomNav, Img, gradFor } from '../ui.jsx';
import { isAdultVerified } from './Profile.jsx';

// NSFW is intentionally NOT in the chips row — it's age-gated behind an
// account-level setting (removed from the visible filter row per the redesign).
const SEARCH_LAYERS = [
  { id: 'all', label: 'All Media', chip: 'All media', icon: Compass, description: 'Search across all sources', placeholder: 'Search movies, shows, live TV & sports…', utility: false },
  { id: 'youtube', label: 'YouTube', chip: 'YouTube', icon: PlayCircle, description: 'Search YouTube videos', placeholder: 'Search YouTube…', utility: false },
  { id: 'direct', label: 'Direct Links', chip: 'Direct links', icon: Link2, description: 'Nkiri shows via DownloadWella', placeholder: 'Search TV shows & movies (Silo, House of the Dragon…) or paste a link', utility: true },
  { id: 'iptv', label: 'IPTV', chip: 'IPTV', icon: Tv, description: 'Live TV channels', placeholder: 'Search live TV channels…', utility: true },
  { id: 'sports', label: 'Sports', chip: 'Sports', icon: Trophy, description: 'Live sports events', placeholder: 'Search live sports…', utility: true },
];

const TRENDING = {
  all: ['Silo', 'House of the Dragon', 'Premier League'],
  youtube: ['Alan Walker Live', 'Top Movies 2026'],
  direct: ['Silo', 'House of the Dragon', 'Squid Game', 'The Last of Us'],
  iptv: ['CNN News', 'ESPN Sports', 'BBC World'],
  sports: ['Premier League', 'Champions League'],
  nsfw: ['Trending', 'Popular'],
};

export default function Browse() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const isMediaRoute = location.pathname === '/media';
  const [searchParams, setSearchParams] = useSearchParams();

  // Chips/Home hand-off: ?layer=direct&q=silo
  const paramLayer = searchParams.get('layer') || '';
  const paramQuery = searchParams.get('q') || '';

  const [activeLayer, setActiveLayer] = useState(
    SEARCH_LAYERS.some((l) => l.id === paramLayer) ? paramLayer : (isMediaRoute ? 'direct' : 'all'),
  );
  const [query, setQuery] = useState(paramQuery);
  const initialSearchDoneRef = useRef(false);
  const [adultVerified, setAdultVerified] = useState(() => isAdultVerified());
  const [showNsfwModal, setShowNsfwModal] = useState(false);
  const [pendingNsfwAction, setPendingNsfwAction] = useState(null);

  const { results, loading, error, search, clear, hasMore, loadMore } = useUnifiedSearch();

  const currentLayer = useMemo(() => SEARCH_LAYERS.find((l) => l.id === activeLayer), [activeLayer]);
  const CurrentLayerIcon = currentLayer?.icon || Film;
  const trending = TRENDING[activeLayer] || TRENDING.all;
  const liveMode = activeLayer === 'iptv' || activeLayer === 'sports' || activeLayer === 'nsfw';

  // Run once on mount if the home search bar handed us a query.
  useEffect(() => {
    initialSearchDoneRef.current = true;
    if (!paramQuery) return;
    setQuery(paramQuery);
    const t = setTimeout(() => { runSearchRef.current?.(paramQuery); }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Search-as-you-type: debounce runs whenever the query changes (450ms).
  // The mount effect handles the ?q= hand-off; this skips that first pass.
  useEffect(() => {
    if (activeLayer === 'direct') return; // direct layer uses ShowBrowser
    const q = query.trim();
    if (!q) return;
    if (initialSearchDoneRef.current === false) return;
    const t = setTimeout(() => runSearchRef.current?.(q), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeLayer]);

  const runSearchRef = useRef(null);

  const runSearch = useCallback(async (targetQuery = query.trim()) => {
    if (!targetQuery) {
      toast('Please enter a search query', { variant: 'warning' });
      return;
    }
    if (activeLayer === 'nsfw' && !adultVerified) {
      setPendingNsfwAction({ type: 'search', query: targetQuery });
      setShowNsfwModal(true);
      return;
    }
    await search({
      layer: activeLayer,
      query: targetQuery,
      options: { adultVerified, resolve: activeLayer === 'nsfw' },
    });
  }, [activeLayer, query, search, adultVerified, toast]);

  useEffect(() => {
    runSearchRef.current = runSearch;
  }, [runSearch]);

  // Direct layer hands off to the shared ShowBrowser (P1: one browser).
  const handleDirectPick = useCallback((content) => {
    if (!content) return;
    const params = new URLSearchParams();
    if (content.kind === 'youtube' && content.videoId) {
      params.set('video', content.videoId);
      params.set('type', 'youtube');
    } else {
      params.set('type', content.videoType || 'direct');
    }
    if (content.title) params.set('title', String(content.title).slice(0, 80));
    // Full url / sourceUrl / synopsis live on location.state — query strings
    // silently truncate long CDN tokens and the room then plays garbage.
    navigate(`/create?${params.toString()}`, {
      state: { from: location.pathname, synopsis: content.synopsis || null, content },
    });
  }, [navigate, location.pathname]);

  const handleLayerClick = useCallback((layerId) => {
    if (layerId === 'nsfw' && !adultVerified) {
      setPendingNsfwAction({ type: 'switch', layer: layerId });
      setShowNsfwModal(true);
      return;
    }
    setActiveLayer(layerId);
    setSearchParams(layerId === 'all' ? {} : { layer: layerId }, { replace: true });
    clear();
  }, [adultVerified, clear, setSearchParams]);

  const handleTrendingClick = useCallback((item) => {
    // Just set the query — the debounced search-as-you-type effect runs it.
    setQuery(item);
  }, []);

  const handleNsfwConfirm = useCallback(() => {
    setAdultVerified(true);
    try { window.localStorage.setItem('chan:adult-verified', '1'); } catch { /* storage unavailable */ }
    setShowNsfwModal(false);
    if (pendingNsfwAction?.type === 'switch') {
      setActiveLayer(pendingNsfwAction.layer);
    } else if (pendingNsfwAction?.type === 'search') {
      setTimeout(() => runSearch(pendingNsfwAction.query), 50);
    }
    setPendingNsfwAction(null);
  }, [pendingNsfwAction, runSearch]);

  const clearSearch = useCallback(() => {
    setQuery('');
    clear();
  }, [clear]);

  // Apply dark theme when media page mounts
  useEffect(() => {
    document.body.classList.add('room-theme');
    return () => document.body.classList.remove('room-theme');
  }, []);

  const head = (
    <>
      <div className="safe-top" />
      <div className="px" style={{ marginTop: 6 }}>
        <h1 style={{ fontSize: 24, letterSpacing: '-.02em' }}>Browse</h1>
      </div>
      <div className="chip-row" style={{ marginTop: 12 }}>
        {SEARCH_LAYERS.map((layer) => (
          <button
            key={layer.id}
            type="button"
            className={`chip${activeLayer === layer.id ? ' active' : ''}`}
            onClick={() => handleLayerClick(layer.id)}
          >
            {layer.chip}
          </button>
        ))}
        {activeLayer === 'nsfw' && (
          <button type="button" className="chip active">Adult (18+)</button>
        )}
      </div>
    </>
  );

  const adultRow = activeLayer !== 'nsfw' ? (
    <button type="button" className="channel-row" style={{ marginTop: 14 }} onClick={() => handleLayerClick('nsfw')}>
      <span className="channel-logo" style={{ background: 'var(--surface3)', color: 'var(--muted)' }}><Lock size={19} /></span>
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>
        <b style={{ fontSize: 14, display: 'block' }}>Adult (18+)</b>
        <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>
          {adultVerified ? 'Age confirmed. Tap to browse adult content.' : 'Off. Confirm your age to browse adult content.'}
        </small>
      </span>
      <span style={{ color: 'var(--faint)' }}><ChevronRight size={16} /></span>
    </button>
  ) : null;

  const loadMoreBlock = results.length > 0 ? (
    <div className="load-more">
      {hasMore ? (
        <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14 }} onClick={loadMore} disabled={loading}>
          {loading ? <Loader2 size={15} className="spin" /> : null}
          {loading ? 'Loading...' : 'Load more'}
        </button>
      ) : (
        <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14, opacity: 0.55 }} disabled>
          That is everything
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="screen with-nav">
      {head}
      <div className="scroll">
        {activeLayer !== 'direct' && (
          <>
            <div className="px" style={{ marginTop: 14 }}>
              <form onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
                <div className="field" style={{ borderRadius: 'var(--r-pill)' }}>
                  <Search size={17} />
                  <input
                    id="unified-search-input"
                    type="text"
                    placeholder={currentLayer?.placeholder || 'Search...'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search media"
                  />
                  {loading
                    ? <Loader2 size={16} className="spin" style={{ color: 'var(--amber)', flex: 'none' }} />
                    : query ? (
                      <button type="button" style={{ color: 'var(--muted)', flex: 'none' }} onClick={clearSearch} aria-label="Clear search">
                        <X size={15} />
                      </button>
                    ) : null}
                </div>
              </form>
            </div>

            {trending.length > 0 && (
              <div className="chip-row" style={{ marginTop: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, fontWeight: 650, flex: 'none' }}>Trending</span>
                {trending.map((item) => (
                  <button key={item} type="button" className="chip" onClick={() => handleTrendingClick(item)}>
                    {item}
                  </button>
                ))}
              </div>
            )}

            {!liveMode && (
              <div className="px" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => navigate('/create')}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: '14px 16px' }}
                >
                  <span style={{ color: 'var(--amber)', flex: 'none' }}><Link2 size={22} /></span>
                  <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <b style={{ fontSize: 14 }}>Have a link instead?</b><br />
                    <small style={{ color: 'var(--muted)', fontSize: 12 }}>YouTube, direct video or Live TV.</small>
                  </span>
                  <span style={{ color: 'var(--faint)', flex: 'none' }}><ChevronRight size={16} /></span>
                </button>
              </div>
            )}

            {error && (
              <div className="err-note">
                <AlertCircle size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>{error}</span>
                <button type="button" onClick={clearSearch}>Dismiss</button>
              </div>
            )}

            {loading && results.length === 0 && (
              liveMode ? (
                <div style={{ padding: '16px var(--gut) 0', display: 'grid', gap: 14 }}>
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <span className="skel" style={{ width: 46, height: 46, borderRadius: 14, flex: 'none' }} />
                      <span style={{ flex: '1 1 auto' }}>
                        <span className="skel" style={{ display: 'block', height: 12, width: '60%' }} />
                        <span className="skel" style={{ display: 'block', height: 10, width: '40%', marginTop: 6 }} />
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="px browse-grid" style={{ marginTop: 16 }}>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <span key={i}>
                      <span className="skel" style={{ display: 'block', aspectRatio: '2/3', borderRadius: 12 }} />
                      <span className="skel" style={{ display: 'block', height: 11, width: '75%', marginTop: 8 }} />
                    </span>
                  ))}
                </div>
              )
            )}

            {results.length > 0 && (
              <>
                <div className="px h-row" style={{ margin: '20px 0 10px' }}>
                  <span className="sec-title">
                    {liveMode ? (activeLayer === 'sports' ? 'Live sports' : 'Live TV') : `${results.length} result${results.length !== 1 ? 's' : ''}`}
                  </span>
                  <button type="button" className="see-all" onClick={clearSearch}>Clear all</button>
                </div>
                {liveMode ? (
                  <div>
                    {results.map((result, idx) => (
                      <LiveRow key={result.id || result.url || idx} result={result} layer={activeLayer} rise={idx} />
                    ))}
                  </div>
                ) : (
                  <div className="px browse-grid">
                    {results.map((result, idx) => (
                      <ResultPoster key={result.id || result.url || idx} result={result} layer={activeLayer} rise={idx} />
                    ))}
                  </div>
                )}
                {loadMoreBlock}
              </>
            )}

            {!loading && results.length === 0 && !error && (
              <div className="px" style={{ marginTop: 18 }}>
                <div className="empty-box">
                  <CurrentLayerIcon size={26} style={{ color: 'var(--amber)' }} />
                  <h4>{query ? 'Ready to search' : 'Search for something'}</h4>
                  <p>
                    {query
                      ? `Tap Search to find "${query}" in ${currentLayer?.label?.toLowerCase() || 'all sources'}`
                      : `Enter a query above to find ${currentLayer?.label?.toLowerCase() || 'content'}`}
                  </p>
                </div>
              </div>
            )}

            {adultRow}
          </>
        )}

        {activeLayer === 'direct' && (
          <div style={{ paddingBottom: 8 }}>
            <ShowBrowser
              onPick={handleDirectPick}
              initialMode="tv"
              hideModeTabs
              placeholder="Search TV shows & movies (Silo, House of the Dragon…) or paste a link"
            />
          </div>
        )}
      </div>

      <Modal open={showNsfwModal} title="Age Verification Required" icon={ShieldAlert} onClose={() => setShowNsfwModal(false)}>
        <div>
          <p style={{ fontSize: 14, lineHeight: 1.55 }}>You must be 18 or older to access adult content.</p>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, marginTop: 6 }}>
            By continuing, you confirm you are of legal age in your jurisdiction.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setShowNsfwModal(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleNsfwConfirm}>I am 18+</Button>
          </div>
        </div>
      </Modal>

      <BottomNav active="browse" />
    </div>
  );
}

/* Result click — ported 1:1 from UnifiedSearch ResultCard.handleClick
   (resolver paths unchanged), except O2TV shows open the Title page
   (seasons/episodes) instead of round-tripping through /create. */
function useResultClick(result, layer) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  return useCallback(async () => {
    if ((result.type || layer) === 'youtube' && result.id) {
      navigate(`/create?video=${result.id}&title=${encodeURIComponent(result.title || 'Untitled')}&type=youtube`, {
        state: { from: location.pathname, synopsis: result.description || result.synopsis || null },
      });
      return;
    }
    if (result.type === 'iptv' || result.isLive) {
      const liveUrl = result.rawUrl || result.url || result.link;
      const playback = /\/api\/proxy\?/i.test(String(result.url || ''))
        ? String(result.url)
        : normalizePlaybackUrl(liveUrl, { forceProxy: true });
      const params = new URLSearchParams({
        videoUrl: playback,
        title: result.title || 'Live Stream',
        type: result.type === 'sports' ? 'sports' : 'iptv',
        isLive: 'true',
      });
      navigate(`/create?${params.toString()}`, { state: { from: location.pathname } });
      return;
    }
    const sourceKey = String(result.source || '').toLowerCase();
    if (sourceKey === 'o2tv' || result.o2tvKind === 'show' || /tvshows4mobile|o2tv/i.test(result.url || '')) {
      if (result.showSlug) {
        navigate('/title', {
          state: {
            slug: result.showSlug,
            name: result.showName || result.title || 'TV Show',
            thumb: result.thumbnail || result.image || null,
          },
        });
        return;
      }
      const params = new URLSearchParams({
        videoUrl: result.url || '',
        title: result.title || 'Untitled',
        type: 'direct',
      });
      if (result.showName) params.set('showName', result.showName);
      navigate(`/create?${params.toString()}`, { state: { from: location.pathname } });
      return;
    }
    if (result.isDirect || result.playableInRoom || isDirectVideoUrl(result.url || '')) {
      const params = new URLSearchParams({
        videoUrl: normalizePlaybackUrl(result.url || result.link || ''),
        title: result.title || 'Video',
        type: ['iptv', 'sports', 'nsfw'].includes(result.type) ? result.type : 'direct',
      });
      navigate(`/create?${params.toString()}`, { state: { from: location.pathname } });
      return;
    }
    if (user) {
      try {
        const token = await user.getIdToken();
        const res = await fetch(apiPath('/api/media'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'scrape', url: result.url || result.link, options: { resolve: true } }),
        });
        const data = await parseJsonResponse(res);
        const directItem = data.results?.find((r) => r.isDirect || r.playableInRoom);
        if (directItem?.url) {
          const params = new URLSearchParams({
            videoUrl: normalizePlaybackUrl(directItem.url),
            title: directItem.title || result.title || 'Video',
            type: 'direct',
          });
          navigate(`/create?${params.toString()}`, { state: { from: location.pathname } });
          return;
        }
      } catch { /* fallback */ }
    }
    toast('Could not resolve this result. Try another option.', { variant: 'error' });
  }, [result, layer, navigate, location.pathname, user, toast]);
}

function sourceLabel(result, layer) {
  const key = String(result.source || layer).toLowerCase();
  if (key === 'youtube') return 'YouTube';
  if (key === 'o2tv') return 'TV Show';
  return String(result.source || layer);
}

function ResultPoster({ result, layer, rise }) {
  const onClick = useResultClick(result, layer);
  const thumb = result.thumbnail || result.image || null;
  const title = cleanMediaTitle(result.title);
  const meta = [result.quality, sourceLabel(result, layer)].filter(Boolean).join(', ');
  return (
    <span className="rise" style={{ minWidth: 0, '--d': `${Math.min(rise, 8) * 40}ms` }}>
      <button
        type="button"
        className="poster"
        style={{ ...gradFor(title), width: '100%', aspectRatio: '2/3' }}
        onClick={onClick}
        aria-label={title}
      >
        <Img src={thumb} alt="" />
        {result.isLive && (
          <span className="pill pill-live" style={{ position: 'absolute', top: 8, left: 8, zIndex: 2 }}>LIVE</span>
        )}
      </button>
      <span className="poster-meta"><b>{title}</b>{meta}</span>
    </span>
  );
}

function LiveRow({ result, layer, rise }) {
  const onClick = useResultClick(result, layer);
  const thumb = result.thumbnail || result.image || null;
  const title = cleanMediaTitle(result.title) || 'Live stream';
  const initials = title.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'TV';
  const meta = [
    result.isLive ? 'Live now' : null,
    result.quality,
    sourceLabel(result, layer),
  ].filter(Boolean).join(', ');
  return (
    <button type="button" className="channel-row rise" style={{ '--d': `${Math.min(rise, 8) * 40}ms` }} onClick={onClick}>
      <span className="channel-logo" style={{ ...gradFor(title), position: 'relative', overflow: 'hidden' }}>
        <Img src={thumb} alt="" />
        <span style={{ position: 'relative', zIndex: 1 }}>{initials}</span>
      </span>
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>
        <b className="truncate" style={{ fontSize: 14, display: 'block' }}>{title}</b>
        <small style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{meta}</small>
      </span>
      {result.isLive && <span className="pill pill-live">LIVE</span>}
    </button>
  );
}
