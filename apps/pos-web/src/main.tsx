import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { devFetch } from './dev/enable.ts';
import { supportsServiceWorker } from './platform/serviceWorker.ts';
import { createServices } from './services.ts';
import './styles.css';
import './pos.css';
import './order-entry.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const fetchOverride = await devFetch();
const services = createServices(fetchOverride ? { fetch: fetchOverride } : {});
services.bindRealtime();
void services.auth.boot();
if (supportsServiceWorker()) services.updates.start();

createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
