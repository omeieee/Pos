/**
 * Entry of the design lab (`/design-lab.html` on the dev server). Not loaded by the app's
 * `main.tsx` and not an input of `vite build`, so it never ships.
 */
import '@fontsource-variable/anuphan/wght.css';
import '@sds/ui/design.css';
import './design-lab.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesignLab } from './DesignLab.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <DesignLab />
  </StrictMode>,
);
