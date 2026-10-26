const CACHE_NAME = 'veyronis-v6.9';
const STATIC_ASSETS = [
    '/',
    '/static/style.css?v=1.5',
    '/static/app.js?v=1.5',
    'https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js',
    'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js',
    'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css',
    'https://cdn.jsdelivr.net/npm/mermaid@10.9.0/dist/mermaid.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js',
    'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js',
    'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js',
    'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css'
];

// Install: cache static assets
self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS);
        }).catch(() => {})
    );
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: cache-first for static, network-first for API
self.addEventListener('fetch', (e) => {
    const { request } = e;
    const url = new URL(request.url);

    // ─── Skip range requests entirely (video streaming returns 206, not cacheable) ───
    if (request.headers.has('range')) return;

    // ─── Only handle GET ───
    if (request.method !== 'GET') return;

    // API calls: network only, but queue if offline
    if (url.pathname.startsWith('/chat') || url.pathname.startsWith('/upload') || url.pathname === '/execute') {
        e.respondWith(networkOrQueue(request));
        return;
    }

    // Health check: network with timeout fallback
    if (url.pathname === '/health') {
        e.respondWith(
            fetch(request, { cache: 'no-store' })
                .catch(() => new Response(JSON.stringify({ status: 'offline' }), {
                    headers: { 'Content-Type': 'application/json' }
                }))
        );
        return;
    }

    // Static assets: cache first, network fallback
    e.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;
            return fetch(request).then(response => {
                // ✅ Only cache FULL 200 responses (not 206, not opaque, not partial)
                if (
                    response.status === 200 &&
                    response.type === 'basic' &&
                    url.origin === self.location.origin
                ) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
                }
                return response;
            }).catch(() => {
                if (request.mode === 'navigate') {
                    return caches.match('/');
                }
                return new Response('', { status: 408 });
            });
        })
    );
});

async function networkOrQueue(request) {
    try {
        const response = await fetch(request);
        // If we were offline and now online, try to flush queue
        await flushQueue();
        return response;
    } catch (err) {
        // Offline: queue the request for later
        const body = await request.clone().text().catch(() => null);
        if (body) {
            const queue = await getQueue();
            queue.push({
                url: request.url,
                method: request.method,
                headers: Array.from(request.headers.entries()),
                body: body,
                timestamp: Date.now()
            });
            await saveQueue(queue);
        }
        return new Response(
            JSON.stringify({ queued: true, message: 'You are offline. Message saved and will send when connection returns.' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

async function getQueue() {
    const cache = await caches.open(CACHE_NAME + '-queue');
    const response = await cache.match('queue');
    if (!response) return [];
    return response.json();
}

async function saveQueue(queue) {
    const cache = await caches.open(CACHE_NAME + '-queue');
    await cache.put('queue', new Response(JSON.stringify(queue), {
        headers: { 'Content-Type': 'application/json' }
    }));
}

async function flushQueue() {
    const queue = await getQueue();
    if (!queue.length) return;

    const remaining = [];
    for (const item of queue) {
        try {
            const headers = new Headers(item.headers);
            await fetch(item.url, { method: item.method, headers, body: item.body });
        } catch {
            remaining.push(item);
        }
    }
    await saveQueue(remaining);
    if (remaining.length < queue.length) {
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(client => {
            client.postMessage({ type: 'queue-flushed', sent: queue.length - remaining.length });
        });
    }
}

// Listen for manual flush from client
self.addEventListener('message', (e) => {
    if (e.data === 'flush-queue') {
        flushQueue();
    }
});