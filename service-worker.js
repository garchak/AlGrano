/* Al Grano — service-worker.js */
const CACHE = 'algrano-v13';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a).catch(()=>{}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const ext = url.pathname.split('.').pop();
  if (ext === 'js' || ext === 'html' || url.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then(res => { if(res.ok){caches.open(CACHE).then(c=>c.put(e.request,res.clone()));} return res; })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(res => { if(res.ok){caches.open(CACHE).then(c=>c.put(e.request,res.clone()));} return res; })
        .catch(() => new Response('offline',{status:503}));
    })
  );
});

/* ══════════════════════════════════════════════════════════
   PUSH — recibe notificaciones aunque la app esté cerrada
══════════════════════════════════════════════════════════ */
self.addEventListener('push', e => {
  console.log('[SW] Push recibido');
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(_) { data = { title:'Al Grano', body: e.data?.text()||'' }; }

  const title = data.title || '⏰ Al Grano';
  const opts  = {
    body:               data.body    || '',
    icon:               data.icon    || './icons/icon-192.png',
    badge:              data.badge   || './icons/icon-192.png',
    tag:                data.tag     || 'algrano-alarm',
    renotify:           true,
    vibrate:            data.vibrate || [200,100,200,100,200],
    data:               data.data    || {},
    requireInteraction: true,
    actions: [
      { action:'open',    title:'Abrir app' },
      { action:'dismiss', title:'Cerrar'    },
    ],
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true })
      .then(list => {
        const existing = list.find(c => c.url.includes(self.location.origin));
        if (existing) return existing.focus();
        return clients.openWindow('./');
      })
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = e.data;
    self.registration.showNotification(title, {
      body, icon:'./icons/icon-192.png', badge:'./icons/icon-192.png',
      tag, renotify:true, vibrate:[200,100,200,100,200],
    });
  }
  if (e.data === 'skipWaiting') self.skipWaiting();
});
