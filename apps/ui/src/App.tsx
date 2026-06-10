import { useEffect, useState } from 'react';
import { NewRun } from './views/NewRun';
import { RunDetail } from './views/RunDetail';
import { Runs } from './views/Runs';
import { useWsConnected } from './ws';

type Route = { view: 'new' } | { view: 'runs' } | { view: 'run'; id: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/runs' || path === '/runs/') return { view: 'runs' };
  const match = /^\/runs\/([^/]+)$/.exec(path);
  const id = match?.[1];
  if (id !== undefined) return { view: 'run', id: decodeURIComponent(id) };
  return { view: 'new' }; // #/new and everything else
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const connected = useWsConnected();

  return (
    <>
      <nav className="nav">
        <a className="wordmark" href="#/new">
          nano<span>fish</span>
        </a>
        <a className={`nav-link ${route.view === 'new' ? 'active' : ''}`} href="#/new">
          New Run
        </a>
        <a
          className={`nav-link ${route.view === 'runs' || route.view === 'run' ? 'active' : ''}`}
          href="#/runs"
        >
          Runs
        </a>
        <span className="nav-spacer" />
        <span
          className={`ws-dot ${connected ? 'on' : 'off'}`}
          title={connected ? 'live events: connected' : 'live events: reconnecting…'}
        />
      </nav>
      <main className="main">
        {route.view === 'new' && <NewRun />}
        {route.view === 'runs' && <Runs />}
        {/* key resets all per-run state when navigating between runs */}
        {route.view === 'run' && <RunDetail key={route.id} runId={route.id} />}
      </main>
    </>
  );
}
