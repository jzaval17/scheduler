const CACHE = 'bm-v1';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Handle incoming push messages (server push) to display notifications when app is closed
self.addEventListener('push', event => {
  try {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Scheduler';
    const options = Object.assign({ body: data.body || '', tag: data.tag || undefined, data: data.data || {} }, data.options || {});
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // fallback: show generic notification
    event.waitUntil(self.registration.showNotification('Scheduler', { body: 'You have an update.' }));
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const urlToOpen = new URL('/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
    for (let i = 0; i < windowClients.length; i++) {
      const client = windowClients[i];
      if (client.url === urlToOpen && 'focus' in client) {
        return client.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(urlToOpen);
  }));
});

// Listen for messages from the page to schedule notifications inside the service worker.
self.addEventListener('message', event => {
  try {
    const msg = event.data;
    if (!msg || msg.type !== 'scheduleNotification') return;
    const title = msg.title || 'Scheduler';
    const body = msg.body || '';
    const tag = msg.tag;
    const when = Number(msg.time) || Date.now();
    const data = msg.data || {};
    // If TimestampTrigger is supported in the service worker, use it to schedule.
    if (typeof TimestampTrigger !== 'undefined') {
      try {
        self.registration.showNotification(title, { body, tag, showTrigger: new TimestampTrigger(when), data });
      } catch (e) {
        // fallback: show immediate notification if scheduling fails
        self.registration.showNotification(title, { body, tag, data });
      }
    } else {
      // TimestampTrigger not available: attempt best-effort immediate fallback
      // We cannot reliably schedule from SW without the API, so just create an immediate notification as fallback.
      self.registration.showNotification(title, { body, tag, data });
    }
  } catch (e) {}
});
