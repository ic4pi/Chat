/**
 * Client switcher + client page. Loaded on the main app and the Workspace.
 * A coloured pill always says whose space you are in; "Personal" is your own.
 */
(function () {
  var API = '/api/hub/state?route=state&action=';
  var COLORS = ['#6aa5ff', '#ff8a5c', '#5fd4a0', '#e58bff', '#ffd25c', '#ff6b8b', '#5cd6e0', '#b0c26a'];
  var activeId = window.__clientId || null;
  var clients = [];

  function api(action, body) {
    var opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(API + action, Object.assign({ credentials: 'include' }, opts)).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || String(r.status));
        return j;
      });
    });
  }
  function colorFor(id) {
    var n = 0; for (var i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % COLORS.length;
    return COLORS[n];
  }
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'style') e.style.cssText = props[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]); else e[k] = props[k];
    });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function lines(s) { return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }

  var pill;
  function paintPill() {
    var cur = clients.filter(function (c) { return c.id === activeId; })[0];
    var name = activeId ? (cur ? cur.name : 'Client') : 'Personal';
    pill.textContent = '';
    pill.appendChild(el('span', { style: 'width:8px;height:8px;border-radius:50%;display:inline-block;background:' + (activeId ? colorFor(activeId) : '#888') }));
    pill.appendChild(el('span', { textContent: name, style: 'max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }));
    pill.title = activeId ? 'Working inside client "' + name + '" — tap to switch' : 'Your own space — tap to switch to a client';
    pill.style.borderColor = activeId ? colorFor(activeId) : 'rgba(255,255,255,.2)';
  }

  function modal(title, body) {
    var back = el('div', { style: 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px' });
    var box = el('div', { role: 'dialog', 'aria-label': title, style: 'background:#14161c;color:#e8e8e8;border:1px solid #2a2e38;border-radius:12px;width:min(480px,100%);max-height:90vh;overflow:auto;padding:16px;font:14px system-ui,sans-serif' });
    var close = function () { back.remove(); };
    box.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px' }, [
      el('strong', { textContent: title, style: 'font-size:16px' }),
      el('button', { type: 'button', textContent: '×', onclick: close, style: 'background:none;border:0;color:#aaa;font-size:20px;cursor:pointer' }),
    ]));
    box.appendChild(body);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.appendChild(box); document.body.appendChild(back);
    return close;
  }
  var btn = 'background:#1f2330;color:#e8e8e8;border:1px solid #333847;border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit';
  var inp = 'width:100%;box-sizing:border-box;background:#0d0f14;color:#e8e8e8;border:1px solid #333847;border-radius:8px;padding:8px;font:inherit;margin:4px 0 10px';

  function openSwitcher() {
    var body = el('div');
    function row(label, id, sub) {
      return el('button', { type: 'button', style: btn + ';display:flex;width:100%;gap:8px;align-items:center;margin-bottom:6px;text-align:left' + (id === activeId ? ';border-color:#6aa5ff' : ''), onclick: function () { if (id !== activeId) window.setActiveClient(id); } }, [
        el('span', { style: 'width:10px;height:10px;border-radius:50%;background:' + (id ? colorFor(id) : '#888') }),
        el('span', { textContent: label, style: 'flex:1' }),
        el('span', { textContent: sub || '', style: 'color:#888;font-size:12px' }),
      ]);
    }
    body.appendChild(row('Personal', null, 'your own space'));
    clients.filter(function (c) { return !c.archived; }).forEach(function (c) {
      body.appendChild(row(c.name, c.id, ''));
    });
    var add = el('div', { style: 'display:flex;gap:6px;margin-top:10px' }, [
      el('input', { id: 'newClientName', placeholder: 'New client name', style: inp + ';margin:0' }),
      el('button', { type: 'button', textContent: 'Add', style: btn, onclick: function () {
        var v = document.getElementById('newClientName').value.trim(); if (!v) return;
        api('client-create', { name: v }).then(function (j) { window.setActiveClient(j.client.id); }).catch(function (e) { alert(e.message); });
      } }),
    ]);
    body.appendChild(add);
    if (activeId) body.appendChild(el('button', { type: 'button', textContent: 'Edit this client…', style: btn + ';margin-top:10px;width:100%', onclick: function () { closeSw(); openClientPage(); } }));
    var archived = clients.filter(function (c) { return c.archived; });
    if (archived.length) body.appendChild(el('div', { style: 'color:#888;font-size:12px;margin-top:10px', textContent: archived.length + ' archived (restore from a client page)' }));
    var closeSw = modal('Switch space', body);
  }

  function openClientPage() {
    var cur = clients.filter(function (c) { return c.id === activeId; })[0];
    if (!cur) return;
    var p = cur.profile || {};
    var f = {};
    function field(label, key, val, tall) {
      var node = el(tall ? 'textarea' : 'input', { value: val, rows: 3, style: inp });
      f[key] = node;
      return el('label', { style: 'display:block;color:#aaa;font-size:12px' }, [label, node]);
    }
    var body = el('div');
    body.appendChild(field('Client name', 'name', cur.name));
    body.appendChild(field('Brand voice', 'voice', p.voice || '', true));
    body.appendChild(field('Audience', 'audience', p.audience || '', true));
    body.appendChild(field('Offer', 'offer', p.offer || '', true));
    body.appendChild(field('Key facts (one per line)', 'facts', (p.facts || []).join('\n'), true));
    body.appendChild(field('Links (one per line)', 'links', (p.links || []).join('\n'), true));
    body.appendChild(field('Always (one per line)', 'dos', (p.dos || []).join('\n'), true));
    body.appendChild(field('Never (one per line)', 'donts', (p.donts || []).join('\n'), true));
    var msg = el('div', { style: 'color:#ff8a8a;min-height:18px;font-size:12px' });
    body.appendChild(msg);
    var bar = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
      el('button', { type: 'button', textContent: 'Save', style: btn + ';background:#2b4a85', onclick: function () {
        api('client-update', { id: cur.id, name: f.name.value, profile: {
          voice: f.voice.value, audience: f.audience.value, offer: f.offer.value,
          facts: lines(f.facts.value), links: lines(f.links.value), dos: lines(f.dos.value), donts: lines(f.donts.value),
        } }).then(function () { location.reload(); }).catch(function (e) { msg.textContent = e.message; });
      } }),
      el('button', { type: 'button', textContent: 'Archive', style: btn, onclick: function () {
        api('client-update', { id: cur.id, archived: true }).then(function () { window.setActiveClient(null); }).catch(function (e) { msg.textContent = e.message; });
      } }),
      el('button', { type: 'button', textContent: 'Delete…', style: btn + ';color:#ff8a8a', onclick: function () {
        var typed = prompt('This permanently deletes "' + cur.name + '" and everything in it (chats, memory, campaigns). Type the client name to confirm:');
        if (typed === null) return;
        api('client-delete', { id: cur.id, confirmName: typed }).then(function () { window.setActiveClient(null); }).catch(function (e) { msg.textContent = e.message; });
      } }),
    ]);
    body.appendChild(bar);
    modal('Client: ' + cur.name, body);
  }

  function mount() {
    pill = el('button', { type: 'button', id: 'clientPill', onclick: openSwitcher, style: 'display:inline-flex;align-items:center;gap:6px;background:#1a1d26;color:#e8e8e8;border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:4px 10px;font:12px system-ui,sans-serif;cursor:pointer;flex:none' });
    var top = document.getElementById('topbar');
    if (top) { top.insertBefore(pill, top.children[1] || null); }
    else { pill.style.cssText += ';position:fixed;bottom:8px;left:8px;z-index:5'; document.body.appendChild(pill); }
    paintPill();
    api('clients-list').then(function (j) {
      clients = j.clients || [];
      // A stored id the server no longer accepts must not leave you in a dead space.
      if (activeId && !clients.some(function (c) { return c.id === activeId && !c.archived; })) { window.setActiveClient(null); return; }
      paintPill();
    }).catch(function () { /* hub off: pill stays on current label */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
