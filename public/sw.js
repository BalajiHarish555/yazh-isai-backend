/* Yazh Isai service worker — app shell + artwork caching.
 * API calls (/api/*) and audio streams always go to network: cached
 * stream URLs expire and cached API data goes stale fast.
 * v3: bump forces every client through a clean install/activate cycle so
 * stale shell caches from earlier deploys are purged (activate deletes
 * every cache not in the current list).
 * v4: upgrade activations force-reload open tabs exactly once per sw.js
 * version, so pages stuck on old bundles (never navigated again) migrate
 * automatically. First installs skip the reload. */
const SCRIPT_VERSION = '6';
const SHELL_CACHE = 'yazh-shell-v5';
const IMAGE_CACHE = 'yazh-images-v1';
const AUDIO_CACHE = 'yazh-audio-v1';
const MAX_IMAGES = 120;

// Upgrade (vs first install): registration.active is the previous worker
// during an update install, and null on a device's very first install.
let isUpgrade = false;

// Hashed Vite assets are immutable; index.html + icons are the shell.
self.addEventListener('install', (event) => {
  isUpgrade = !!self.registration.active;
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/', '/index.html', '/logo.png'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== IMAGE_CACHE && k !== AUDIO_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
      // One reload per sw.js version, upgrade activations only.
      if (isUpgrade) {
        const flagUrl = `/yazh-reloaded-${SCRIPT_VERSION}`;
        const shell = await caches.open(SHELL_CACHE);
        if (!(await shell.match(flagUrl))) {
          await shell.put(flagUrl, new Response('1'));
          const windows = await self.clients.matchAll({ type: 'window' });
          await Promise.all(windows.map((c) => c.navigate(c.url).catch(() => undefined)));
        }
      }
    })(),
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

// Serve a full cached Response with proper Range slicing. A plain
// cache.match answers 200-full to Range requests, which breaks the audio
// element's seeking and stalls playback.
function sliceCachedResponse(stored, rangeHeader) {
  return stored.arrayBuffer().then((buf) => {
    const total = buf.byteLength;
    const type = stored.headers.get('content-type') || 'audio/webm';
    if (!rangeHeader) {
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
        },
      });
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    let start = 0;
    let end = total - 1;
    if (m) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      });
    }
    return new Response(buf.slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
      },
    });
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API: network only (fast-staling data).
  if (url.pathname.startsWith('/api/')) return;

  // Saved offline tracks: serve the blob stored by "Download" from
  // AUDIO_CACHE, with manual Range slicing so seeking works offline.
  // (A plain cache.match would answer 200-full to Range requests, which
  // breaks the audio element's seeking and stalls playback.)
  if (url.pathname.startsWith('/offline-track-')) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const stored = await cache.match(url.pathname);
        if (!stored) {
          try {
            return await fetch(request);
          } catch {
            return new Response(null, { status: 503 });
          }
        }
        return sliceCachedResponse(stored, request.headers.get('range'));
      }),
    );
    return;
  }

  const isAudio =
    /\.(mp3|mp4|m4a|webm|ogg|wav|flac)(\?|$)/i.test(url.pathname) ||
    url.hostname.includes('googlevideo.com') ||
    url.hostname.includes('saavncdn.com');

  // Saved Saavn tracks: immutable CDN files -> cache-first (this is what
  // makes offline playback work). Range requests are sliced so seeking
  // works on cached tracks. Everything else audio (expiring googlevideo
  // URLs) stays network-only so stale links can never stick.
  if (isAudio) {
    if (!url.hostname.includes('saavncdn.com')) return;
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return sliceCachedResponse(cached, request.headers.get('range'));
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
