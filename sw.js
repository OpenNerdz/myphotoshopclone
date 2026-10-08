// Service worker: makes the editor installable and usable offline.
// Strategy: network-first for same-origin GETs (always fresh when online),
// falling back to the cache when offline or when the network stalls.

const VERSION = '2.0.2';
const CACHE = `overlay-studio-${VERSION}`;
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
    './', // not 'index.html': Netlify may redirect it, and redirects can't answer navigations
    'styles.css',
    'manifest.webmanifest',
    'icons/icon.svg',
    'icons/favicon-32.png',
    'icons/icon-192.png',
    'icons/apple-touch-icon.png',
    'js/app.js',
    'js/compat.js',
    'js/compositor.js',
    'js/controls.js',
    'js/crop.js',
    'js/dialogs.js',
    'js/dom.js',
    'js/exporter.js',
    'js/filters.js',
    'js/geometry.js',
    'js/history.js',
    'js/images.js',
    'js/layers-panel.js',
    'js/main.js',
    'js/properties.js',
    'js/renderer.js',
    'js/samples.js',
    'js/shell.js',
    'js/storage.js',
    'js/toast.js',
    'js/viewport.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k.startsWith('overlay-studio-') && k !== CACHE).map((k) => caches.delete(k)));
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE);
            const network = fetch(request).then((response) => {
                if (response.ok && response.type === 'basic') {
                    event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
                }
                return response;
            });
            network.catch(() => {}); // a rejection after we answered from cache is expected
            const cached = await cache.match(request, { ignoreSearch: true });
            try {
                if (!cached) return await network;
                // Don't let a stalled connection block startup when we have a copy.
                return await Promise.race([network, new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS))]);
            } catch {
                if (cached) return cached;
                if (request.mode === 'navigate') {
                    const shell = await cache.match('./');
                    if (shell) return shell;
                }
                return Response.error();
            }
        })()
    );
});
