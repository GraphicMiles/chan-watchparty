import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { ShowBrowser } from '../../shared/components/ShowBrowser.jsx';
import { BottomNav } from '../ui.jsx';

/* Title page: opens one show (seasons → episodes) through the shared
   ShowBrowser. Episode taps resolve there and hand off to Create exactly
   like the Browse direct layer does. */
export default function Title() {
  const navigate = useNavigate();
  const location = useLocation();
  const browserRef = useRef(null);
  const state = location.state || {};
  const { slug, pageUrl, name, thumb } = state;

  useEffect(() => {
    if (!slug && !pageUrl) {
      navigate('/search?layer=direct', { replace: true });
      return;
    }
    const t = setTimeout(() => {
      if (slug) browserRef.current?.openShowBySlug(slug, name, thumb);
      else if (pageUrl) browserRef.current?.openPageUrl(pageUrl, name);
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePick = useCallback((content) => {
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

  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/search');
  };

  return (
    <div className="screen with-nav">
      <div className="safe-top" />
      <div className="px" style={{ flex: 'none', marginTop: 2 }}>
        <button type="button" className="icon-btn" onClick={goBack} aria-label="Back">
          <ChevronLeft size={19} />
        </button>
      </div>
      <div className="scroll" style={{ paddingTop: 8 }}>
        <ShowBrowser ref={browserRef} onPick={handlePick} initialMode="tv" hideModeTabs hideSearch />
        <p className="helper px" style={{ marginTop: 14 }}>
          Tap an episode to resolve its link and start a watch party.
        </p>
      </div>
      <BottomNav active="browse" />
    </div>
  );
}
