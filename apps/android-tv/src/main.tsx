import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/index.css';
import './styles/tv.css';

// ── Capacitor shim: подменяем window.electronAPI на HTTP-адаптер
//    чтобы ВЕСЬ существующий код (сервисы + компоненты) работал без правок ──
if ((window as any).Capacitor && !window.electronAPI) {
  import('./utils/bridge').then(({ getBridge }) => {
    (window as any).electronAPI = getBridge();
    render();
  });
} else {
  render();
}

function render() {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
