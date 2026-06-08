// Service worker : installation en "appli" + TOUJOURS la dernière version des pages.
// Stratégie "réseau d'abord, sans cache" pour les pages HTML → plus besoin de rechargement forcé.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => {
  const req = e.request;
  // Uniquement les navigations / documents HTML : on force la version réseau (pas de cache).
  if (req.method === 'GET' && (req.mode === 'navigate' || req.destination === 'document')) {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => fetch(req))
    );
  }
  // Tout le reste (API Supabase, SDK, images…) : comportement normal du navigateur.
});
