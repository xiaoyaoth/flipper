const CACHE_PREFIX = "clarity-flipper-";
const CACHE_NAME = `${CACHE_PREFIX}20261008-17`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=20261008-17",
  "./vendor/tensorflow/tf.min.js?v=20261008-17",
  "./vendor/tensorflow/speech-commands.min.js?v=20261008-17",
  "./vendor/blazeface/blazeface.min.js?v=20261008-17",
  "./distance-control.js?v=20261008-17",
  "./voice-control.js?v=20261008-17",
  "./app.js?v=20261008-17",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./distance-model/model.json",
  "./distance-model/group1-shard1of1.bin",
  "./voice-model/model.json",
  "./voice-model/metadata.json",
  "./voice-model/group1-shard1of1.bin",
];

self.addEventListener("install", (event) => {
  const appShellRequests = APP_SHELL.map(
    (url) => new Request(url, { cache: "reload" }),
  );
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(appShellRequests)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "reload" })
        .then((response) => {
          if (!response.ok) {
            return response;
          }

          const copy = response.clone();
          return caches
            .open(CACHE_NAME)
            .then((cache) => cache.put("./index.html", copy))
            .then(() => response);
        })
        .catch(() =>
          caches
            .match("./index.html")
            .then((cachedResponse) => cachedResponse || caches.match("./")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((response) => {
        if (!response.ok || response.type !== "basic") {
          return response;
        }

        const copy = response.clone();
        return caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(request, copy))
          .then(() => response);
      });
    }),
  );
});
