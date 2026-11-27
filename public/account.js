// Sign in / create account / sign out / reset password / "I'm the owner".
// Everything typed by a person goes in with textContent or .value, never innerHTML.
(function () {
  'use strict';

  var overlay = null;
  var me = null; // { email, isOwner, plan } or null

  function el(tag, props) {
    var n = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) n.append(arguments[i]);
    return n;
  }

  // Node.append(null) writes the literal word "null", so empty slots are skipped.
  function put(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.append(arguments[i]); }

  function api(op, body) {
    return fetch('/api/account?op=' + op, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  // The persona list, posting accounts and brands all depend on who is signed in: reload to refetch them.
  function reloadClean() { location.href = location.pathname; }

  function close() { if (overlay) { overlay.remove(); overlay = null; } }

  function open(render) {
    close();
    var box = el('div', { class: 'modal', style: 'padding:18px' });
    overlay = el('div', { class: 'modal-overlay' }, box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.append(overlay);
    render(box);
  }

  var fieldCss = 'display:block;width:100%;margin:6px 0 0;padding:10px;box-sizing:border-box;background:var(--panel-2);color:var(--text);border:1px solid var(--border-2);border-radius:8px;font:inherit;font-size:16px';
  var btnCss = 'white-space:nowrap;padding:10px 16px;border-radius:8px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);cursor:pointer;font:inherit';
  var primaryCss = btnCss + ';background:var(--accent,#ff2e63);border-color:var(--accent,#ff2e63);color:#fff';

  function field(label, input) { return el('label', { style: 'display:block;margin:12px 0 0;font-size:13px;color:var(--muted)', text: label }, input); }
  function input(type, auto, extra) { return el('input', Object.assign({ type: type, autocomplete: auto, autocapitalize: 'off', spellcheck: 'false', style: fieldCss }, extra || {})); }

  function signedOutView(box, mode) {
    var email = input('email', 'email');
    var pw = input('password', mode === 'signup' ? 'new-password' : 'current-password', mode === 'signup' ? { minlength: '10' } : {});
    var msg = el('div', { style: 'min-height:20px;margin-top:12px;font-size:13px;color:#FB7185;white-space:pre-wrap' });
    var go = el('button', { type: 'button', style: primaryCss, text: mode === 'signup' ? 'Create account' : 'Sign in' });
    function submit() {
      go.disabled = true; msg.textContent = '';
      api(mode === 'signup' ? 'signup' : 'login', { email: email.value, password: pw.value })
        .then(reloadClean)
        .catch(function (err) { msg.textContent = err.message; go.disabled = false; });
    }
    go.addEventListener('click', submit);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    var tab = function (label, m) {
      return el('button', { type: 'button', text: label, style: btnCss + (m === mode ? ';border-color:var(--accent,#ff2e63)' : ''), onclick: function () { box.replaceChildren(); signedOutView(box, m); } });
    };
    put(box, 
      el('h3', { text: 'Account', style: 'margin:0 0 10px' }),
      el('div', { style: 'display:flex;gap:8px' }, tab('Sign in', 'login'), tab('Create account', 'signup')),
      field('Email', email),
      field(mode === 'signup' ? 'Password (at least 10 characters)' : 'Password', pw),
      msg,
      el('div', { style: 'display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:8px' },
        el('button', { type: 'button', text: 'Forgot password?', style: 'background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:inherit;font-size:13px;padding:0', onclick: function () { box.replaceChildren(); forgotView(box); } }),
        el('div', { style: 'display:flex;gap:8px' }, el('button', { type: 'button', text: 'Close', style: btnCss, onclick: close }), go)),
      mode === 'signup' ? el('p', { text: 'Free accounts use the free models. Paid models and higher limits need a paid plan.', style: 'font-size:12px;color:var(--muted-2);margin:14px 0 0' }) : null
    );
  }

  function forgotView(box) {
    var email = input('email', 'email');
    var msg = el('div', { style: 'min-height:20px;margin-top:12px;font-size:13px;white-space:pre-wrap' });
    var go = el('button', { type: 'button', style: primaryCss, text: 'Email me a link' });
    go.addEventListener('click', function () {
      go.disabled = true; msg.style.color = ''; msg.textContent = '';
      api('reset-request', { email: email.value })
        .then(function () { msg.textContent = 'If that account exists, a reset link is on its way. It works for one hour.'; })
        .catch(function (err) { msg.style.color = '#FB7185'; msg.textContent = err.message; go.disabled = false; });
    });
    put(box, el('h3', { text: 'Reset your password', style: 'margin:0 0 10px' }), field('Your account email', email), msg,
      el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px' },
        el('button', { type: 'button', text: 'Back', style: btnCss, onclick: function () { box.replaceChildren(); signedOutView(box, 'login'); } }), go));
  }

  function resetView(box, token) {
    var pw = input('password', 'new-password', { minlength: '10' });
    var msg = el('div', { style: 'min-height:20px;margin-top:12px;font-size:13px;color:#FB7185;white-space:pre-wrap' });
    var go = el('button', { type: 'button', style: primaryCss, text: 'Set new password' });
    go.addEventListener('click', function () {
      go.disabled = true; msg.textContent = '';
      api('reset', { token: token, password: pw.value })
        .then(function () { history.replaceState(null, '', location.pathname); box.replaceChildren(); signedOutView(box, 'login'); box.prepend(el('p', { text: 'Password changed. Sign in with it.', style: 'margin:0 0 10px;color:var(--text)' })); })
        .catch(function (err) { msg.textContent = err.message; go.disabled = false; });
    });
    put(box, el('h3', { text: 'Choose a new password', style: 'margin:0 0 10px' }), field('New password (at least 10 characters)', pw), msg,
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, go));
  }

  function signedInView(box) {
    var msg = el('div', { style: 'min-height:20px;margin-top:10px;font-size:13px;color:#FB7185;white-space:pre-wrap' });
    var claimBox = el('div', { style: 'display:none;margin-top:8px' });
    var u = input('text', 'username', { placeholder: 'Admin username' });
    var p = input('password', 'current-password', { placeholder: 'Admin password' });
    var claim = el('button', { type: 'button', style: primaryCss, text: 'Make this account the owner' });
    claim.addEventListener('click', function () {
      claim.disabled = true; msg.textContent = '';
      api('claim-owner', { adminUser: u.value, adminPassword: p.value })
        .then(reloadClean)
        .catch(function (err) { msg.textContent = err.message; claim.disabled = false; });
    });
    claimBox.append(u, p, el('div', { style: 'margin-top:8px' }, claim));
    put(box, 
      el('h3', { text: 'Account', style: 'margin:0 0 10px' }),
      el('div', { text: me.email, style: 'font-size:16px;word-break:break-all' }),
      el('div', { text: (me.isOwner ? 'Owner · ' : '') + (me.plan === 'pro' ? 'Pro plan' : 'Free plan'), style: 'font-size:13px;color:var(--muted);margin-top:4px' }),
      me.plan === 'pro' ? null : el('p', { text: 'Free: the free models. Paid models and higher limits need a paid plan.', style: 'font-size:12px;color:var(--muted-2);margin:12px 0 0' }),
      msg,
      me.isOwner ? null : el('button', { type: 'button', text: 'I\'m the owner of this app', style: 'background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:inherit;font-size:13px;padding:0;margin-top:6px', onclick: function () { claimBox.style.display = claimBox.style.display === 'none' ? '' : 'none'; } }),
      me.isOwner ? null : claimBox,
      el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px' },
        el('button', { type: 'button', text: 'Close', style: btnCss, onclick: close }),
        el('button', { type: 'button', text: 'Sign out', style: primaryCss, onclick: function () { api('logout', {}).then(reloadClean).catch(function (err) { msg.textContent = err.message; }); } }))
    );
  }

  function openAccount() { open(function (box) { if (me) signedInView(box); else signedOutView(box, 'login'); }); }

  function refreshLabels() {
    var label = me ? me.email : 'Sign in';
    var top = document.getElementById('accountTopBtn');
    if (top) { top.title = me ? 'Account: ' + me.email : 'Sign in or create an account'; top.classList.toggle('signed-in', !!me); }
    var sub = document.getElementById('accountCardSub');
    if (sub) sub.textContent = me ? (me.isOwner ? 'Owner' : 'Signed in') : 'Sign in or create one';
    var nm = document.getElementById('accountCardName');
    if (nm) nm.textContent = me ? 'Account' : 'Sign in';
    if (nm) nm.title = label;
  }

  function mount() {
    var menuBtn = document.getElementById('menuBtn');
    if (menuBtn && !document.getElementById('accountTopBtn')) {
      var b = el('button', { id: 'accountTopBtn', class: 'icon-btn', type: 'button', 'aria-label': 'Account', onclick: openAccount });
      b.innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';   // static icon, no user data
      menuBtn.parentNode.insertBefore(b, menuBtn);
    }
    var grid = document.querySelector('#appSheet .module-grid');
    if (grid && !document.getElementById('accountCard')) {
      var card = el('button', { id: 'accountCard', class: 'module-card', type: 'button', onclick: function () { var s = document.getElementById('sheetScrim'); if (s) s.click(); openAccount(); } },
        el('span', { class: 'm-ico', text: '◉' }), el('span', { id: 'accountCardName', class: 'm-name', text: 'Sign in' }), el('span', { id: 'accountCardSub', class: 'm-sub', text: 'Sign in or create one' }));
      grid.append(card);
    }
    refreshLabels();
  }

  function init() {
    mount();
    var token = new URLSearchParams(location.search).get('reset');
    api('me').then(function (d) { me = d.account || null; refreshLabels(); }).catch(function () { /* signed out view still works */ })
      .then(function () { if (token) open(function (box) { resetView(box, token); }); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
