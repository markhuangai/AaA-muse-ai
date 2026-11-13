import { createRoot } from 'react-dom/client';
import { BrowserAPI } from './api';
import { App } from './app';
import { PortalController } from './controller';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist-mono/latin-400.css';
import './styles.css';

export function mount(element: HTMLElement, controller = new PortalController(new BrowserAPI())) {
  const root = createRoot(element);
  root.render(<App controller={controller} />);
  return () => { root.unmount(); controller.dispose(); };
}

const element = document.getElementById('root');
if (element) mount(element);
