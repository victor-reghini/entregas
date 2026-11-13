// Organiza Entregas - Service Worker Offline First
const CACHE_NAME = "organiza-entregas-v9";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/env.js",
  "./js/icons.js",
  "./js/optimizer.js",
  "./js/scanner.js",
  "./js/photo-storage.js",
  "./js/firebase-service.js",
  "./js/app.js",
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
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn("PWA pre-cache warning:", err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Strictly only handle same-origin assets to avoid interfering with CDN scripts or external APIs
  if (url.origin !== self.location.origin) {
    return;
  }

  // Network-first for navigation requests so users always get the freshest version when online
  if (event.request.mode === "navigate" || event.request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match("./index.html") || await caches.match("/");
          return cached || Response.error();
        })
    );
    return;
  }

  // Stale-while-revalidate / Cache-First for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Refresh cache in background if online
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
          })
          .catch(() => {});
        return cached;
      }

      return fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
    })
  );
});
