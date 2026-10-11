/* Yazh Isai service worker — app shell + artwork caching.
 * API calls (/api/*) and audio streams always go to network: cached
 * stream URLs expire and cached API data goes stale fast. */
const SHELL_CACHE = 'yazh-shell-v1';
const IMAGE_CACHE = 'yazh-images-v1';
const AUDIO_CACHE = 'yazh-audio-v1';
const MAX_IMAGES = 120;

// Hashed Vite assets are immutable; index.html + icons are the shell.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/', '/index.html', '/logo.png'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== IMAGE_CACHE && k !== AUDIO_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function trimImages() {
  const cache = await caches.open(IMAGE_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_IMAGES) {
    await cache.delete(keys[0]);
    return trimImages();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API: network only (fast-staling data).
  if (url.pathname.startsWith('/api/')) return;

  const isAudio =
    /\.(mp3|mp4|m4a|webm|ogg|wav|flac)(\?|$)/i.test(url.pathname) ||
    url.hostname.includes('googlevideo.com') ||
    url.hostname.includes('saavncdn.com');

  // Saved Saavn tracks: immutable CDN files -> cache-first (this is what
  // makes offline playback work). Everything else audio (expiring
  // googlevideo URLs) stays network-only so stale links can never stick.
  if (isAudio) {
    if (!url.hostname.includes('saavncdn.com')) return;
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Images (artwork, thumbs): stale-while-revalidate, capped.
  if (request.destination === 'image') {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              cache.put(request, res.clone());
              trimImages();
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // Navigations: network first, shell fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // App shell (JS/CSS/fonts): cache first, refresh in background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res && res.ok && (url.origin === self.location.origin || request.destination === 'font')) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      });
      return cached || network;
    }),
  );
});
