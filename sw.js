const CACHE = 'tbr-cache-v155';

const PRECACHE_SAME = [
  '/',
  '/index.html',
  '/manifest.json'
];

const PRECACHE_CROSS = [
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Barlow+Condensed:wght@300;400;500;600;700&family=Barlow:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/@zxing/library@latest/umd/index.min.js'
];

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => Promise.all([
      ...PRECACHE_SAME.map(url => cache.add(url).catch(() => {})),
      ...PRECACHE_CROSS.map(url => cache.add(new Request(url, {mode: 'no-cors'})).catch(() => {}))
    ]))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: siempre intenta traer la versión más nueva; si falla (sin conexión), usa la caché
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // Dejar pasar sin intervenir las peticiones a APIs externas (ej: Mercado Libre, proxies CORS)
  // que no forman parte del precache, para que la página maneje sus propios errores de red/CORS.
  if (url.origin !== self.location.origin && !PRECACHE_CROSS.includes(req.url)) {
    return;
  }
  event.respondWith(
    fetch(req)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return resp;
      })
      .catch(() =>
        caches.match(req).then(cached => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('/index.html');
          return undefined;
        })
      )
  );
});
