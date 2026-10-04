import '@fontsource-variable/anuphan/wght.css';
import '@sds/ui/glass.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createApiClient } from './api/client.ts';
import { devBackend } from './dev/enable.ts';
import { InviteApp } from './invite/InviteApp.tsx';
import { createInviteStore } from './invite/invite-store.ts';
import { isInvitePath, takeInviteToken } from './platform/appLocation.ts';
import { webClipboard } from './platform/clipboard.ts';
import { apiBaseUrl } from './platform/config.ts';
import { supportsServiceWorker } from './platform/serviceWorker.ts';
import { createServices } from './services.ts';
import './styles.css';
import './pos.css';
import './order-entry.css';
import './orders.css';
import './payment.css';
import './kitchen.css';
import './outbox.css';
import './menu-editor.css';
import './settings.css';
import './glass-theme.css';
// Last, so the redesign ("Hot bowl, calm glass") wins over older rules of the same weight.
import '@sds/ui/design.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// An invite link (D-23) is `/invite#<token>`: a page of its own, with no session. The token leaves
// the address bar first, before anything else runs, and lives only in the invite store's memory.
const onInvitePage = isInvitePath(window.location.pathname);
const inviteToken = onInvitePage ? takeInviteToken() : null;

const backend = await devBackend();

if (onInvitePage) {
  // No services: no sign-in boot, no realtime, no saved tokens. Only the two public calls, which
  // send neither a session nor a device token.
  const api = createApiClient({
    baseUrl: apiBaseUrl,
    ...(backend ? { fetch: backend.fetch } : {}),
    getSessionToken: () => null,
    getDeviceToken: () => null,
  });
  const invite = createInviteStore({ api: api.auth });
  invite.start(inviteToken);
  createRoot(root).render(
    <StrictMode>
      <InviteApp store={invite} clipboard={webClipboard} />
    </StrictMode>,
  );
} else {
  const services = createServices(backend ?? {});
  services.bindRealtime();
  void services.auth.boot();
  if (supportsServiceWorker()) services.updates.start();

  createRoot(root).render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
}
