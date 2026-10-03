import { resolveTokens, toCssVariables } from '@sds/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// The shared design tokens, for a phone, as CSS variables (docs: design/brand.md).
const tokens = document.createElement('style');
tokens.textContent = toCssVariables(resolveTokens('iphone'), ':root');
document.head.append(tokens);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
