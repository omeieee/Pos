import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { devBackend } from './dev/enable.ts';
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

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const backend = await devBackend();
const services = createServices(backend ?? {});
services.bindRealtime();
void services.auth.boot();
if (supportsServiceWorker()) services.updates.start();

createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
