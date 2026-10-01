import { formatDate } from '@sds/i18n';
import { useEffect } from 'react';
import { allowedRoutes, pathFromHash, resolveRoute } from '../app/routes.ts';
import { Brand } from './Brand.tsx';
import { useAuthState, useAuthStore, useHash, useLocale, useNow, useT } from './hooks.ts';
import { Icon } from './Icon.tsx';

/**
 * The signed-in frame: top bar (shop, device, person, role, sign out), navigation limited to
 * what the role may open, and the page. Every page is a friendly placeholder for now.
 */
export function Shell() {
  const auth = useAuthStore();
  const state = useAuthState();
  const tr = useT();
  const locale = useLocale();
  const now = useNow(60_000);
  const hash = useHash();
  const session = state.session;
  const routes = allowedRoutes(session?.permissions ?? []);
  const resolved = resolveRoute(hash, routes);
  const route = resolved?.route ?? null;

  // A page this role may not open (or an unknown address) is replaced by the first allowed one.
  // A page with a parameter keeps its own address, so it is compared as a whole.
  useEffect(() => {
    if (resolved && pathFromHash(hash) !== resolved.path) {
      window.location.replace(`#${resolved.path}`);
    }
  }, [hash, resolved]);

  if (!session) return null;
  const signOutLabel = tr('shell.signOut');

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__brand">
          <Brand />
        </div>
        <div className="topbar__meta">
          {state.device ? (
            <span className="chip">{tr('shell.device', { name: state.device.name })}</span>
          ) : null}
          <span className="chip chip--person">
            <Icon name="user" />
            <span>{session.staff.displayName}</span>
            <span className="chip__role">{tr(`role.${session.staff.role}`)}</span>
          </span>
          <time className="topbar__date" dateTime={new Date(now).toISOString()}>
            {formatDate(now, locale, 'date')}
          </time>
        </div>
        <button
          type="button"
          className="btn btn-soft topbar__signout"
          aria-label={signOutLabel}
          onClick={() => void auth.signOut()}
        >
          <Icon name="door" />
          <span className="topbar__signout-label">{signOutLabel}</span>
        </button>
      </header>

      <nav className="nav" aria-label={tr('nav.label')}>
        {routes.map((item) => (
          <a
            key={item.id}
            className="nav__item"
            href={`#${item.path}`}
            aria-current={route?.id === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            <span>{tr(item.labelKey)}</span>
          </a>
        ))}
      </nav>

      <main className="page">
        {route ? (
          <section className="coming-soon">
            <span className="coming-soon__art" aria-hidden="true">
              <span className="i i-bowl" />
            </span>
            <h1>{tr('comingSoon.title')}</h1>
            <p className="muted">{tr('comingSoon.body', { page: tr(route.labelKey) })}</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
