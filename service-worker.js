// Garde une copie de l'appli (HTML/CSS/JS/icÃ´nes) pour qu'elle dÃ©marre mÃªme
// sans rÃ©seau. RÃ©seau d'abord : une mise Ã  jour publiÃ©e est prise tout de
// suite, la copie ne sert que hors connexion.
// Garde aussi, pour rouler sans rÃ©seau, la carte OpenFreeMap (tuiles
// vectorielles, polices, icÃ´nes) et les bibliothÃ¨ques de carte dÃ©jÃ  vues ou
// prÃ©parÃ©es. Les autres services (TomTom, bornes, mÃ©tÃ©o) ne passent pas ici :
// TomTom interdit de stocker ses cartes, et les autres doivent Ãªtre frais.

const CACHE_NOM = "trajetve-v46";
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
  "./js/ui-installation.js",
  "./js/restauration.js",
  "./js/trajet.js",
  "./js/planner.js",
  "./js/energie.js",
  "./js/courbe.js",
  "./js/carte.js",
  "./js/carte3d.js",
  "./js/parkings.js",
  "./js/hors-ligne.js",
  "./js/navigation.js",
  "./js/zoom-nav.js",
  "./js/alertes-route.js",
  "./js/osm-route.js",
  "./js/ui-zones.js",
  "./js/panneau-nav.js",
  "./js/icones-voiture.js",
  "./js/recherche-route.js",
  "./js/ui-suggestions.js",
  "./js/ui-voiture.js",
  "./js/commandes-vocales.js",
  "./js/graphique-batterie.js",
  "./js/meteo-route.js",
  "./js/statistiques.js",
  "./js/ui-stats.js",
  "./js/ui-quand-partir.js",
  "./js/ui-arret-impose.js",
  "./js/ui-partage.js",
  "./js/drive.js",
  "./js/ui-drive.js",
  "./js/icones.js",
  "./js/sos.js",
  "./js/ui-sos.js",
  "./js/nav-outils.js",
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
      // Seulement les anciennes copies de l'appli (pas les donnÃ©es gardÃ©es
      // par l'appli elle-mÃªme, comme l'Ã©tat des bornes).
      .then((noms) => Promise.all(noms.filter((n) => n.startsWith("trajetve-v") && n !== CACHE_NOM).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// â”€â”€ Carte et bibliothÃ¨ques pour le hors ligne â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CACHE_CARTES = "trajetve-cartes";
const HOTES_CARTES = ["tiles.openfreemap.org", "cdn.jsdelivr.net", "unpkg.com"];
const MAX_ELEMENTS_CARTES = 6000;
let ajoutsDepuisMenage = 0;

// Adresses versionnÃ©es (tuiles, polices, icÃ´nes, bibliothÃ¨ques) : elles ne
// changent jamais, la copie gardÃ©e suffit. Le style (non versionnÃ©) passe
// d'abord par le rÃ©seau pour rester Ã  jour.
function immuable(url) {
  return url.pathname.endsWith(".pbf") || url.pathname.includes("/sprites/") || url.pathname.includes("/natural_earth/") || url.hostname !== "tiles.openfreemap.org";
}

async function menageCartes(cache) {
  const cles = await cache.keys();
  const surplus = cles.length - MAX_ELEMENTS_CARTES;
  // Les plus anciennes d'abord (ordre d'ajout).
  for (let i = 0; i < surplus + 500 && surplus > 0; i++) await cache.delete(cles[i]);
}

async function carteOuReseau(requete) {
  const url = new URL(requete.url);
  const cache = await caches.open(CACHE_CARTES);
  if (immuable(url)) {
    const garde = await cache.match(requete);
    if (garde) return garde;
  }
  try {
    const reponse = await fetch(requete);
    // Â« opaque Â» : bibliothÃ¨ques chargÃ©es par <script> (Leafletâ€¦), sans quoi
    // l'appli ne dÃ©marrerait pas hors connexion.
    if (reponse.ok || reponse.type === "opaque") {
      await cache.put(requete, reponse.clone());
      if (++ajoutsDepuisMenage >= 200) {
        ajoutsDepuisMenage = 0;
        menageCartes(cache);
      }
    }
    return reponse;
  } catch (e) {
    const garde = await cache.match(requete);
    if (garde) return garde;
    throw e;
  }
}

// Notification de guidage (écran verrouillé) : un toucher rouvre l'appli.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
      const f = fenetres[0];
      return f ? f.focus() : self.clients.openWindow("./index.html");
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (HOTES_CARTES.includes(url.hostname)) {
    event.respondWith(carteOuReseau(event.request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // "no-cache" : GitHub Pages autorise 10 min de cache navigateur, pendant
  // lesquelles une version publiÃ©e n'arrivait pas. On revalide Ã  chaque fois
  // (rÃ©ponse 304 lÃ©gÃ¨re si rien n'a changÃ©).
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
