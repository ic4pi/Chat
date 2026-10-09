import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { pullSettings } from './settingsSync.js';
import './theme.css';

// Teams and seat picks come back from the server first when this browser
// lost them; a slow answer that arrives late reloads once to use them.
void pullSettings({ onLateRestore: () => window.location.reload() }).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
