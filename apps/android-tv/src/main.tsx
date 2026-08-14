import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../desktop/src/styles/index.css'; // Базовые стили
import './styles/tv.css'; // TV-оверрайды

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
