/* ══════════════════════════════════════════════════════════════
   AL GRANO — service-worker.js
   Estrategia: Cache-first para assets, network-first para datos
══════════════════════════════════════════════════════════════ */

const CACHE_NAME    = 'algrano-v1';
const CACHE_DYNAMIC = 'algrano-dynamic-v1';

// Assets que se cachean en la instalación
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Fuentes de Google (si hay conexión en la primera carga)
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=DM+Mono:wght@300;400&display=swap'
];

/* ── Instalación ────────────────────────────── */
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando…');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pre-cacheando assets estáticos');
        // Intentamos cachear cada asset individualmente para no fallar en bloque
        return Promise.allSettled(
          STATIC_ASSETS.map(url =>
            cache.add(url).catch(err => console.warn(`[SW] No se pudo cachear: ${url}`, err))
          )
        );
      })
      .then(() => self.skipWaiting()) // activar inmediatamente
  );
});

/* ── Activación ─────────────────────────────── */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activando…');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CACHE_DYNAMIC)
          .map(k => {
            console.log('[SW] Eliminando cache antigua:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim()) // tomar control inmediato
  );
});

/* ── Fetch: estrategia híbrida ──────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar peticiones no GET
  if (request.method !== 'GET') return;

  // Ignorar peticiones al API de reconocimiento de voz (externas, no cacheables)
  if (url.hostname.includes('speech') || url.hostname.includes('google.com/speech')) return;

  // Estrategia: Cache-first para assets estáticos
  if (isStaticAsset(request)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Estrategia: Network-first con fallback a cache para el resto
  event.respondWith(networkFirst(request));
});

/* ── Helpers de estrategia ──────────────────── */

/**
 * Cache-first: devuelve el recurso del cache si existe,
 * si no lo busca en red y lo guarda.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline y sin cache — devolver página offline si existe
    return caches.match('/index.html');
  }
}

/**
 * Network-first: intenta red primero, si falla usa cache.
 * Actualiza el cache en background cuando hay red.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_DYNAMIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Fallback final
    return caches.match('/index.html') || new Response('Offline', { status: 503 });
  }
}

/**
 * Determinar si un request es un asset estático
 */
function isStaticAsset(request) {
  const url = new URL(request.url);
  const ext = url.pathname.split('.').pop();
  return ['html','css','js','png','jpg','jpeg','svg','ico','woff','woff2','json']
    .includes(ext) || url.pathname === '/';
}

/* ── Mensajes desde el cliente ──────────────── */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();

  // Limpiar caches bajo demanda
  if (event.data === 'clearCache') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
