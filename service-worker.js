/* Al Grano — service-worker.js v3 */

// Cambiar este número cada vez que se despliega una nueva versión
const CACHE = 'algrano-v11';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Instalar: cachear assets
self.addEventListener('install', e => {
  console.log('[SW] instalando v3');
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a).catch(err => console.warn('[SW] no cacheado:', a, err)))))
      .then(() => self.skipWaiting())  // activar inmediatamente sin esperar
  );
});

// Activar: borrar caches antiguas
self.addEventListener('activate', e => {
  console.log('[SW] activando v3, limpiando caches viejas');
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('[SW] borrando cache antigua:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())  // tomar control de todas las pestañas
  );
});

// Fetch: network-first para JS/HTML (siempre código fresco), cache-first para resto
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const ext = url.pathname.split('.').pop();

  // Para JS y HTML: network primero (código siempre actualizado)
  if (ext === 'js' || ext === 'html' || url.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Para el resto (CSS, imágenes): cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => new Response('offline', { status: 503 }));
    })
  );
});

/* ── Notificaciones push desde el SW ───────────────────────
   Cuando la app está cerrada, el SW puede mostrar notificaciones
   usando showNotification() que sí soporta vibración y badge
── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Abrir la app al pulsar la notificación
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si ya hay una pestaña abierta, enfocarla
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      // Si no, abrir una nueva
      return clients.openWindow('./');
    })
  );
});

/* ── Sync periódico: revisar alarmas al despertar el SW ──── */
self.addEventListener('sync', e => {
  if (e.tag === 'check-alarms') {
    console.log('[SW] sync check-alarms');
  }
});

/* ── Mensajes desde la app ─────────────────────────────── */
self.addEventListener('message', e => {
  // La app puede pedir al SW que muestre una notificación
  // (útil cuando la app está en background en iOS)
  if (e.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = e.data;
    self.registration.showNotification(title, {
      body,
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-192.png',
      tag,
      renotify: true,
      vibrate: [200, 100, 200, 100, 200],
    });
  }
  if (e.data === 'skipWaiting') self.skipWaiting();
});
