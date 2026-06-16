import { useEffect, useState } from 'react';
import { NewRun } from './views/NewRun';
import { Profiles } from './views/Profiles';
import { Queries } from './views/Queries';
import { RunDetail } from './views/RunDetail';
import { Runs } from './views/Runs';
import { useWsConnected } from './ws';

type Route =
  | { view: 'new' }
  | { view: 'runs' }
  | { view: 'run'; id: string }
  | { view: 'queries' }
  | { view: 'profiles' };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/runs' || path === '/runs/') return { view: 'runs' };
  if (path === '/queries' || path === '/queries/') return { view: 'queries' };
  if (path === '/profiles' || path === '/profiles/') return { view: 'profiles' };
  const match = /^\/runs\/([^/]+)$/.exec(path);
  const id = match?.[1];
  if (id !== undefined) return { view: 'run', id: decodeURIComponent(id) };
  return { view: 'new' }; // #/new and everything else
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(globalThis.location.hash));
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(globalThis.location.hash));
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
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
          sor<span>tie</span>
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
        <a className={`nav-link ${route.view === 'queries' ? 'active' : ''}`} href="#/queries">
          Queries
        </a>
        <a className={`nav-link ${route.view === 'profiles' ? 'active' : ''}`} href="#/profiles">
          Profiles
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
        {route.view === 'queries' && <Queries />}
        {route.view === 'profiles' && <Profiles />}
        {/* key resets all per-run state when navigating between runs */}
        {route.view === 'run' && <RunDetail key={route.id} runId={route.id} />}
      </main>
    </>
  );
}
