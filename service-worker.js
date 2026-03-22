/* Al Grano — service-worker.js v3 */

// Cambiar este número cada vez que se despliega una nueva versión
const CACHE = 'algrano-v5';

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
