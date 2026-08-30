/* Live sync between the server and every screen.
 *
 * Uses Server-Sent Events, which reconnect on their own — pull the Wi-Fi out
 * mid-show and the display re-syncs the moment it comes back. If the page is
 * opened straight off the filesystem (file://) with no server at all, it
 * falls back to a BroadcastChannel so two tabs on one laptop still work. */
(function (global) {
  'use strict';

  var listeners = [];
  var connListeners = [];
  var latest = null;
  var source = null;
  var connected = false;
  var localMode = location.protocol === 'file:';
  var channel = null;

  function pin() {
    try { return localStorage.getItem('mm-pin') || ''; } catch (e) { return ''; }
  }

  function setPin(value) {
    try { localStorage.setItem('mm-pin', value || ''); } catch (e) {}
  }

  function emit(snapshot) {
    latest = snapshot;
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](snapshot); } catch (err) { console.error('[bus] listener failed', err); }
    }
  }

  function setConnected(value, note) {
    if (connected === value) return;
    connected = value;
    for (var i = 0; i < connListeners.length; i++) {
      try { connListeners[i](value, note); } catch (err) {}
    }
  }

  function connect() {
    if (localMode) return connectLocal();
    if (source) source.close();
    source = new EventSource('/api/stream');
    source.addEventListener('state', function (ev) {
      setConnected(true);
      try { emit(JSON.parse(ev.data)); } catch (err) { console.error('[bus] bad frame', err); }
    });
    source.addEventListener('open', function () { setConnected(true); });
    source.addEventListener('error', function () {
      setConnected(false, 'reconnecting');
      // EventSource retries by itself using the server's retry hint.
    });
  }

  /* --- offline/no-server fallback: two tabs on the same machine --- */
  function connectLocal() {
    if (!('BroadcastChannel' in global)) return;
    channel = new BroadcastChannel('millionaire-local');
    channel.onmessage = function (ev) {
      if (ev.data && ev.data.type === 'state') emit(ev.data.snapshot);
      if (ev.data && ev.data.type === 'hello' && latest) channel.postMessage({ type: 'state', snapshot: latest });
    };
    channel.postMessage({ type: 'hello' });
    setConnected(true, 'local');
  }

  function request(path, options) {
    options = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var p = pin();
    if (p) headers['X-Admin-Pin'] = p;
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  var Bus = {
    connect: connect,
    onState: function (fn) { listeners.push(fn); if (latest) fn(latest); },
    onConnection: function (fn) { connListeners.push(fn); fn(connected); },
    get snapshot() { return latest; },
    get isLocal() { return localMode; },
    pin: pin,
    setPin: setPin,

    /** Fire a game action; the server answers with the new snapshot. */
    send: function (action) {
      if (localMode) return Promise.resolve(null);
      return request('/api/action', { method: 'POST', body: action }).then(function (snap) {
        if (snap && snap.state) emit(snap);
        return snap;
      });
    },

    get: function (path) { return request(path); },
    put: function (path, body) { return request(path, { method: 'PUT', body: body }); },
    post: function (path, body) { return request(path, { method: 'POST', body: body }); },
    del: function (path) { return request(path, { method: 'DELETE' }); },

    /** Used by the local (server-less) fallback to push state between tabs. */
    publishLocal: function (snapshot) {
      emit(snapshot);
      if (channel) channel.postMessage({ type: 'state', snapshot: snapshot });
    }
  };

  global.Bus = Bus;

  // Cache the app shell so a phone that has loaded the remote once keeps
  // working through a Wi-Fi hiccup mid-show.
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})(window);
