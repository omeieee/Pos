import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { devFetch } from './dev/enable.ts';
import { createServices } from './services.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const fetchOverride = await devFetch();
const { auth } = createServices(fetchOverride ? { fetch: fetchOverride } : {});
void auth.boot();

createRoot(root).render(
  <StrictMode>
    <App auth={auth} />
  </StrictMode>,
);
