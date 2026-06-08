// Service worker minimal : permet l'installation en "appli" (raccourci écran d'accueil)
// et le badge sur l'icône. Pas de cache agressif (passthrough réseau).
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => { /* réseau direct */ });
