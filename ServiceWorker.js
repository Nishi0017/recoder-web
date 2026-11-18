"use strict";

const scope = self.registration.scope;
const cachePrefix = "recoder-offline:" + scope + ":";
// Bump this when changing the HTML, styles, scripts, or icons in the Web template.
const shellRevision = "9";
const buildFiles = [
  "Build/4b5c69902ebe78bb670dcf6d671a07d6.loader.js",
  "Build/b266baf77a0022e8ce860a6118ab266e.data",
  "Build/ed6bca5e6af4619aa907183ff2195428.framework.js",
  "Build/d161a87ab53d5755c11f3ce09f61e18b.wasm"
];
const cacheName = cachePrefix + shellRevision + ":" + buildFiles.join(",");
const shellFiles = [
  "index.html",
  "recorder.css",
  "recorder.js",
  "recording-store.js",
  "offline.js",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png"
];
const appFiles = new Set([...shellFiles, ...buildFiles].map(path => new URL(path, scope).href));
const index = new URL("index.html", scope).href;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...appFiles].map(url => new Request(url, { cache: "reload" })));
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(cachePrefix) && key !== cacheName)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  url.search = "";
  const key = request.mode === "navigate" && (url.href === scope || url.href === index)
    ? index
    : request.url;
  if (!appFiles.has(key)) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(key)) || fetch(request);
  })());
});





self.addEventListener('message', event => {
  if (event.data?.type === 'GET_VERSION') event.ports[0]?.postMessage({revision: shellRevision});
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
