import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpendSmartProvider } from './data/SpendSmartProvider';
import App from './App';
import './tokens.css';
import './styles.css';
import './workflows.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><SpendSmartProvider><App /></SpendSmartProvider></StrictMode>,
);
