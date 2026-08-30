/* Caches the whole app so a phone that has opened it once keeps working even
 * if the laptop's Wi-Fi drops mid-show. Bump CACHE when files change. */
var CACHE = 'millionaire-v1';
var SHELL = [
  '/', '/display', '/admin',
  '/css/display.css', '/css/admin.css',
  '/js/bus.js', '/js/audio.js', '/js/display.js', '/js/admin.js', '/js/qr.js',
  '/icons/icon.svg', '/manifest.webmanifest'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(SHELL);
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  // Live data and the event stream must always hit the server.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(event.request).then(function (hit) {
        return hit || caches.match('/admin');
      });
    })
  );
});
