const CACHE_NAME = "homesteader-shell-v2";
const APP_SCOPE = new URL(self.registration.scope);
const SHELL_FILES = ["./", "./styles.css", "./pwa.js", "./manifest.webmanifest", "./favicon.ico", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("homesteader-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== APP_SCOPE.origin || !url.pathname.startsWith(APP_SCOPE.pathname) || url.pathname.endsWith("/version.json")) return;
  const cacheKey = new Request(url.origin + url.pathname);
  event.respondWith(fetch(request, { cache: "no-store" }).then((response) => {
    if (response.ok && response.type === "basic") {
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, response.clone())).catch(() => {}));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(cacheKey);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const home = await caches.match(new Request(APP_SCOPE.href));
      if (home) return home;
    }
    return Response.error();
  }));
});
