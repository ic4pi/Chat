import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { pullSettings } from './settingsSync.js';
import { startWorkspaceSync } from './workspaceSync.js';
import './theme.css';

// Teams, seat picks and Code Space sessions come from the server first when
// this browser lost them or another linked device moved on; a slow answer
// that arrives late reloads once to use it.
void Promise.all([
  pullSettings({ onLateRestore: () => window.location.reload() }),
  startWorkspaceSync(),
]).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
