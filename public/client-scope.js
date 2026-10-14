/**
 * Client workspace scope — runs first on every page (main app and Workspace).
 *
 * The active client lives in localStorage. Two things follow from it:
 *  1. Every request to this site's /api gets an X-Client-Id header, which the
 *     server verifies against the signed-in owner (a bad id is a 403, never a
 *     fallback to your own space).
 *  2. The per-space localStorage keys (chats, Workspace sessions, plans, teams)
 *     are suffixed with the client id, so a client's local data never mixes with
 *     another's. Keys and tokens stay global.
 */
(function () {
  var ACTIVE = 'active_client_id_v1';
  var SCOPED = {
    uncensored_chat_state_v3: 1, agent_session_v1: 1, agent_sessions_v2: 1, agent_sessions_active_v2: 1,
    workspace_build_plan_v1: 1, workspace_coding_team_v1: 1, workspace_saved_teams_v1: 1,
    workspace_orchestrator_v1: 1, workspace_settings_sync_v1: 1, workspace_sessions_sync_v1: 1,
    chat_to_workspace_v1: 1, uncensored_role_models_v1: 1, workspace_run_log_v1: 1,
  };
  var id = '';
  try { id = localStorage.getItem(ACTIVE) || ''; } catch (e) { /* blocked storage */ }
  window.__clientId = id || null;

  if (id) {
    var P = Storage.prototype;
    var get = P.getItem, set = P.setItem, rem = P.removeItem;
    var map = function (self, k) { return self === window.localStorage && SCOPED[k] ? k + '::' + id : k; };
    P.getItem = function (k) { return get.call(this, map(this, k)); };
    P.setItem = function (k, v) { return set.call(this, map(this, k), v); };
    P.removeItem = function (k) { return rem.call(this, map(this, k)); };

    var f = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var local = url.charAt(0) === '/' || url.indexOf(location.origin) === 0;
        if (local && /\/api\//.test(url)) {
          var h = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || undefined);
          h.set('X-Client-Id', id);
          init = Object.assign({}, init, { headers: h });
        }
      } catch (e) { /* fall through unchanged */ }
      return f.call(this, input, init);
    };
  }

  window.setActiveClient = function (next) {
    try {
      if (next) localStorage.setItem(ACTIVE, next); else localStorage.removeItem(ACTIVE);
    } catch (e) { /* ignore */ }
    location.reload();
  };
})();
