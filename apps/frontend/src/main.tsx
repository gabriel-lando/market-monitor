import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App.js';
import { registerServiceWorker } from './register-service-worker.js';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.PROD) {
  void registerServiceWorker();
}
