import { useEffect, useSyncExternalStore } from 'react';
import { competitorIdSchema } from '@rounds/shared';
import { CompetitorList } from './features/competitors/CompetitorList';
import { CompetitorTimeline } from './features/timeline/CompetitorTimeline';
import { EmptyState } from './components/Feedback';
import { Icon } from './components/Icon';

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
function readRoute(): { kind: 'list' } | { kind: 'timeline'; id: string } | { kind: 'missing' } {
  const hash = window.location.hash;
  if (!hash || hash === '#/' || hash === '#') return { kind: 'list' };
  const match = /^#\/competitors\/([^/]+)$/.exec(hash);
  if (!match) return { kind: 'missing' };
  try {
    const result = competitorIdSchema.safeParse(decodeURIComponent(match[1]!));
    return result.success ? { kind: 'timeline', id: result.data } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
}

export function App() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const route = readRoute();
  useEffect(() => {
    document.title =
      route.kind === 'timeline' ? `${route.id} · CompetitorPulse` : 'Competitors · CompetitorPulse';
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>('main h1')?.focus();
  }, [hash]); // The route is derived solely from the URL hash.
  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <a href="#/" className="brand" aria-label="CompetitorPulse home">
            <span className="brand-mark">
              <Icon name="pulse" />
            </span>
            Competitor<span>Pulse</span>
          </a>
          <nav aria-label="Main navigation">
            <a
              className="nav-link"
              href="#/"
              aria-current={route.kind === 'list' ? 'page' : undefined}
            >
              Competitors
            </a>
          </nav>
          <span className="workspace-label">INTERNAL WORKSPACE</span>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        {route.kind === 'list' ? (
          <CompetitorList />
        ) : route.kind === 'timeline' ? (
          <CompetitorTimeline key={route.id} id={route.id} />
        ) : (
          <div className="surface">
            <h1 className="sr-only">Page not found</h1>
            <EmptyState title="This page could not be found">
              Check the link or <a href="#/">return to your competitors</a>.
            </EmptyState>
          </div>
        )}
      </main>
      <footer className="app-footer">
        <span>CompetitorPulse</span>
        <span>Less noise. More context.</span>
      </footer>
    </>
  );
}
