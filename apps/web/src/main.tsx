import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import '../../../packages/ui/src/tokens.css';
import './entry.css';
const root=document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<App />);
