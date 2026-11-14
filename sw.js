// Organiza Entregas - Service Worker Offline First
const APP_VERSION = "1.1.4";
const CACHE_NAME = "organiza-entregas-v14";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css?v=1.1.4",
  "./js/env.js",
  "./js/icons.js",
  "./js/optimizer.js?v=1.1.4",
  "./js/scanner.js",
  "./js/photo-storage.js",
  "./js/firebase-service.js",
  "./js/app.js?v=1.1.4",
  "./apple-touch-icon.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg",
  "./icons/favicon.ico",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./vendor/images/marker-icon.png",
  "./vendor/images/marker-icon-2x.png",
  "./vendor/images/marker-shadow.png",
  "./vendor/xlsx.full.min.js",
  "./vendor/html5-qrcode.min.js",
  "./vendor/firebase-app-compat.js",
  "./vendor/firebase-auth-compat.js",
  "./vendor/firebase-firestore-compat.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const freshRequests = STATIC_ASSETS.map((url) => new Request(url, { cache: "reload" }));
      return cache.addAll(freshRequests).catch(() => {
        return cache.addAll(STATIC_ASSETS).catch((err) => {
          console.warn("PWA pre-cache warning:", err);
        });
      });
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (event.data.type === "GET_VERSION" && event.source) {
    event.source.postMessage({ type: "APP_VERSION", version: APP_VERSION });
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Strictly only handle same-origin assets to avoid interfering with CDN scripts or external APIs
  if (url.origin !== self.location.origin) {
    return;
  }

  // Atomic version cache: serve navigation & static assets from this SW's CACHE_NAME first
  // so HTML/CSS/JS always stay in sync until the user confirms the new SW version.
  if (event.request.mode === "navigate" || event.request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request) || await cache.match("./index.html") || await cache.match("./");
        if (cached) return cached;
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.status === 200) {
            cache.put("./index.html", networkResponse.clone());
          }
          return networkResponse;
        } catch {
          return Response.error();
        }
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const networkResponse = await fetch(event.request);
        if (networkResponse && networkResponse.status === 200) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        return cached || Response.error();
      }
    })
  );
});
