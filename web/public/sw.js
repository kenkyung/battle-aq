// Battle-AQ service worker: makes the game installable as an app (M18).
// It passes every request to the network — versioned assets are already
// cached by the browser, and the game needs the server to play anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });
