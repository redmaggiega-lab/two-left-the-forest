// Cache the shell so the book opens without a connection.
// The game itself still needs the network — that's what the
// other player's position travels over.
const CACHE = "tlf-v1";
const SHELL = ["./", "./index.html", "./game.js", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // never cache Firebase traffic — it has to be live
  if (url.hostname.indexOf("firebaseio") > -1 ||
      url.hostname.indexOf("googleapis") > -1) return;

  // network first, fall back to cache, so edits show up right away
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok && e.request.method === "GET" && url.origin === location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
