const CACHE = "mamta-kids-v4";
const CORE = ["/", "/index.html", "/shop.html", "/product.html", "/account.html", "/checkout.html", "/css/style.css", "/JS/gate.js", "/JS/script.js", "/manifest.webmanifest", "/images/fashion-logo.png", "/images/payment-qr.jpg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
    if (event.request.method !== "GET" || event.request.url.includes("/api/")) return;
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match("/index.html"))));
});
