const STATIC_CACHE = "dms-static-v3";
const OFFLINE_URL = "offline.html";
const BYPASS_RE = /^\/(api\/.*|socket\.io\/.*)$/;

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  // Take over immediately instead of waiting for every open tab to close —
  // makes a fixed/updated sw.js (e.g. after the version bump above) apply on
  // the very next reload rather than requiring a full browser restart.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.add(OFFLINE_URL)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      // Purge every cache from a previous STATIC_CACHE name — bump the
      // version above whenever a bad/stale entry needs to be force-evicted
      // from everyone's Cache Storage, not just this browser's.
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))),
      ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // Server Actions, form posts, logout — always network

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope).pathname; // '/' or '/dms/'
  const appPath = url.pathname.startsWith(scope) ? "/" + url.pathname.slice(scope.length) : url.pathname;

  if (BYPASS_RE.test(appPath)) return; // API/socket.io — always network
  if (appPath.includes("/_next/image")) return; // dynamic, never content-hashed
  if (appPath.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  // everything else: pass through, no caching either direction
});
