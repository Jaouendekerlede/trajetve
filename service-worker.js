// Garde une copie de l'appli (HTML/CSS/JS/icônes) pour qu'elle démarre même
// sans réseau. Réseau d'abord : une mise à jour publiée est prise tout de
// suite, la copie ne sert que hors connexion. Les API externes (TomTom,
// Open Charge Map, IRVE, Open-Meteo, cartes) ne passent jamais par ici.

const CACHE_NOM = "trajetve-v16";
const FICHIERS_COQUILLE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/main.js",
  "./js/ui.js",
  "./js/ui-commun.js",
  "./js/ui-journal.js",
  "./js/ui-abonnements.js",
  "./js/ui-sauvegarde.js",
  "./js/ui-parkings.js",
  "./js/ui-accueil.js",
  "./js/trajet.js",
  "./js/planner.js",
  "./js/energie.js",
  "./js/courbe.js",
  "./js/carte.js",
  "./js/carte3d.js",
  "./js/parkings.js",
  "./js/navigation.js",
  "./js/irve.js",
  "./js/ocm.js",
  "./js/tomtom.js",
  "./js/geo.js",
  "./js/storage.js",
  "./js/config.js",
  "./js/util.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NOM)
      .then((cache) => cache.addAll(FICHIERS_COQUILLE.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Seulement les anciennes copies de l'appli (pas les données gardées
      // par l'appli elle-même, comme l'état des bornes).
      .then((noms) => Promise.all(noms.filter((n) => n.startsWith("trajetve-v") && n !== CACHE_NOM).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // "no-cache" : GitHub Pages autorise 10 min de cache navigateur, pendant
  // lesquelles une version publiée n'arrivait pas. On revalide à chaque fois
  // (réponse 304 légère si rien n'a changé).
  event.respondWith(
    fetch(event.request.url, { cache: "no-cache" })
      .then((reponse) => {
        if (reponse.ok) {
          const copie = reponse.clone();
          caches.open(CACHE_NOM).then((cache) => cache.put(event.request, copie));
        }
        return reponse;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("./index.html"))),
  );
});
