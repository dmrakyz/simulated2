/**
 * Error / Console Panel — loaded as a regular <script> so it intercepts
 * errors even if ES module imports fail entirely.
 * Exposes: window.ErrPanel
 */
(function () {
  'use strict';

  const PANEL_ID   = 'err-panel';
  const LIST_ID    = 'err-list';
  const BADGE_ID   = 'err-badge';
  const BTN_OPEN   = 'err-open-btn';

  let entries = [];
  let panelEl = null, listEl = null, badgeEl = null, btnEl = null;
  let panelOpen = false;
  let errorCount = 0;

  /* ── DOM bootstrap (called when DOM is ready) ──────────────── */
  function mount() {
    panelEl  = document.getElementById(PANEL_ID);
    listEl   = document.getElementById(LIST_ID);
    badgeEl  = document.getElementById(BADGE_ID);
    btnEl    = document.getElementById(BTN_OPEN);

    if (!panelEl) return;

    document.getElementById('err-copy-btn').addEventListener('click', function () {
      const text = entries.map(function (e) {
        return '[' + e.time + '] [' + e.type.toUpperCase() + '] ' + e.msg +
          (e.stack ? '\n' + e.stack : '');
      }).join('\n---\n');
      navigator.clipboard.writeText(text).catch(function () {
        /* fallback: select a textarea */
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      });
      document.getElementById('err-copy-btn').textContent = 'Copied!';
      setTimeout(function () {
        document.getElementById('err-copy-btn').textContent = 'Copy All';
      }, 1500);
    });

    document.getElementById('err-clear-btn').addEventListener('click', function () {
      entries = [];
      errorCount = 0;
      listEl.innerHTML = '';
      syncBadge();
      closePanel();
    });

    document.getElementById('err-close-btn').addEventListener('click', closePanel);

    if (btnEl) {
      btnEl.addEventListener('click', function () {
        panelOpen ? closePanel() : openPanel();
      });
    }

    /* flush any entries queued before DOM was ready */
    var queued = window._ErrQueue || [];
    queued.forEach(function (q) { addEntry(q.type, q.msg, q.stack); });
    window._ErrQueue = null;
  }

  /* ── Panel open / close ────────────────────────────────────── */
  function openPanel() {
    if (!panelEl) return;
    panelOpen = true;
    panelEl.classList.add('open');
  }

  function closePanel() {
    if (!panelEl) return;
    panelOpen = false;
    panelEl.classList.remove('open');
  }

  function syncBadge() {
    if (badgeEl) badgeEl.textContent = entries.length;
    if (btnEl) {
      btnEl.dataset.hasError = (errorCount > 0) ? 'true' : 'false';
    }
  }

  /* ── Add an entry ──────────────────────────────────────────── */
  function addEntry(type, msg, stack) {
    var t = new Date().toTimeString().slice(0, 8);
    var entry = { type: type, msg: String(msg), stack: stack || '', time: t };
    entries.push(entry);

    if (type === 'error') { errorCount++; openPanel(); }

    if (!listEl) {
      /* queue until DOM mounts */
      window._ErrQueue = window._ErrQueue || [];
      window._ErrQueue.push(entry);
      return;
    }

    var row = document.createElement('div');
    row.className = 'err-row err-' + type;

    var typeEl = document.createElement('span');
    typeEl.className = 'err-type';
    typeEl.textContent = type.toUpperCase();

    var timeEl = document.createElement('span');
    timeEl.className = 'err-time';
    timeEl.textContent = t;

    var msgEl = document.createElement('span');
    msgEl.className = 'err-msg';
    msgEl.textContent = msg;

    row.appendChild(typeEl);
    row.appendChild(timeEl);
    row.appendChild(msgEl);

    if (stack) {
      var stackEl = document.createElement('pre');
      stackEl.className = 'err-stack';
      stackEl.textContent = stack;
      row.appendChild(stackEl);
    }

    listEl.appendChild(row);
    listEl.scrollTop = listEl.scrollHeight;
    syncBadge();
  }

  /* ── Global interceptors ───────────────────────────────────── */
  window.addEventListener('error', function (e) {
    addEntry('error',
      (e.message || 'Unknown error') +
        (e.filename ? ' (' + (e.filename.split('/').pop()) + ':' + e.lineno + ':' + e.colno + ')' : ''),
      e.error && e.error.stack ? e.error.stack : ''
    );
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var msg = (reason && reason.message) ? reason.message : String(reason);
    var stack = (reason && reason.stack) ? reason.stack : '';
    addEntry('error', 'Unhandled Promise rejection: ' + msg, stack);
  });

  /* intercept console */
  var _methods = ['log', 'info', 'warn', 'error', 'debug'];
  _methods.forEach(function (m) {
    var orig = console[m].bind(console);
    console[m] = function () {
      orig.apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).map(function (a) {
        if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
        try { return typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a); }
        catch (_) { return String(a); }
      }).join(' ');
      var type = m === 'error' ? 'error' : m === 'warn' ? 'warn' : 'log';
      addEntry(type, msg, '');
    };
  });

  /* ── Public API ────────────────────────────────────────────── */
  window.ErrPanel = {
    mount  : mount,
    add    : addEntry,
    open   : openPanel,
    close  : closePanel,
    entries: entries
  };

  /* auto-mount when DOM ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
