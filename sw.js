/* sw.js — app-shell cache so the installed app opens offline.
 * Only same-origin static files are cached; proxy API calls always go to the network.
 */
'use strict';

const CACHE = 'duty-hours-v6';
const SHELL = ['./', 'index.html', 'app.js', 'fun.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => cache.add(u).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Network-first for the shell (so a push to GitHub shows up on next open), cache as offline fallback.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req) || (req.mode === 'navigate' && await caches.match('index.html'));
      if (hit) return hit;
      throw err;
    }
  })());
});
