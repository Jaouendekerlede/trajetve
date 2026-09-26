// Préparer un trajet pour rouler sans réseau : on télécharge à l'avance la
// carte OpenFreeMap le long du tracé (le service worker la garde), ce qu'il
// faut pour l'afficher en 3D (style, polices, icônes, moteur), et le guidage
// TomTom (instructions, voies), rangé à part pour la navigation.

import { rectanglesZonesEvitees } from "./storage.js";
import { getApiKeys } from "./config.js";
import { calculerItineraireTomTom } from "./tomtom.js";
import { haversineKm } from "./geo.js";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAPLIBRE = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl";
const POLICES = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"];
// Latin de base et accents, puis ponctuation (’ « »…).
const PLAGES_GLYPHES = ["0-255", "256-511", "8192-8447"];
const ZOOM_MIN = 6;
const ZOOM_MAX = 14;
// Au-delà, zoom trop fin pour élargir autour du tracé (trop de tuiles).
const ZOOM_MAX_VOISINES = 12;
const TAILLE_MOYENNE_TUILE_KO = 25;
const TELECHARGEMENTS_SIMULTANES = 6;
const CLE_GUIDAGE = "tve_guidage_hors_ligne";

function tuile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

// Tuiles couvrant le tracé à chaque zoom : bande d'une tuile de large aux
// zooms fins, élargie d'une tuile de chaque côté aux zooms larges (carte
// inclinée : on voit loin sur les côtés).
export function tuilesDuTrace(coords) {
  const tuiles = new Set();
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
    const marge = z <= ZOOM_MAX_VOISINES ? 1 : 0;
    // Pas d'échantillonnage : un point par demi-tuile environ.
    const pasKm = (40075 / 2 ** z) * 0.5;
    let depuis = Infinity;
    let precedent = null;
    for (const [lon, lat] of coords) {
      if (precedent) depuis += haversineKm(precedent[1], precedent[0], lat, lon);
      precedent = [lon, lat];
      if (depuis < pasKm) continue;
      depuis = 0;
      const [x, y] = tuile(lat, lon, z);
      for (let dx = -marge; dx <= marge; dx++) for (let dy = -marge; dy <= marge; dy++) tuiles.add(`${z}/${x + dx}/${y + dy}`);
    }
    const [lon, lat] = coords[coords.length - 1];
    const [x, y] = tuile(lat, lon, z);
    tuiles.add(`${z}/${x}/${y}`);
  }
  return [...tuiles];
}

export function estimerPreparation(plan) {
  const n = tuilesDuTrace(plan.coords).length;
  return { tuiles: n, mo: Math.round((n * TAILLE_MOYENNE_TUILE_KO) / 1024) };
}

async function telecharger(urls, onProgres, depart = 0, total = urls.length) {
  let fait = depart;
  let ok = 0;
  const file = [...urls];
  async function ouvrier() {
    while (file.length) {
      const url = file.shift();
      try {
        const r = await fetch(url);
        if (r.ok || r.type === "opaque") ok++;
      } catch {
        // Tuile manquée : le reste de la carte reste utilisable.
      }
      onProgres?.(++fait, total);
    }
  }
  await Promise.all(Array.from({ length: TELECHARGEMENTS_SIMULTANES }, ouvrier));
  return ok;
}

// Guidage complet du trajet (via les bornes prévues), gardé pour démarrer ou
// recalculer la navigation sans réseau.
export async function preparerGuidage(plan) {
  const arrets = (plan.arrets || []).map((a) => ({ lat: a.lat, lon: a.lon }));
  const r = await calculerItineraireTomTom(getApiKeys().tomtom, plan.from_lat, plan.from_lon, plan.to_lat, plan.to_lon, { etapes: arrets, instructions: true, zonesEvitees: rectanglesZonesEvitees() });
  if (r.erreur) return false;
  localStorage.setItem(CLE_GUIDAGE, JSON.stringify({ ts: Date.now(), to_lat: plan.to_lat, to_lon: plan.to_lon, nb_arrets: arrets.length, route: r }));
  return true;
}

// Guidage gardé pour cette destination et ce nombre de bornes restantes.
export function guidageHorsLigne(lat, lon, nbArrets) {
  try {
    const g = JSON.parse(localStorage.getItem(CLE_GUIDAGE));
    if (!g || g.nb_arrets !== nbArrets || haversineKm(g.to_lat, g.to_lon, lat, lon) > 0.3) return null;
    return g.route;
  } catch {
    return null;
  }
}

// onProgres(fait, total) pendant le téléchargement.
export async function preparerHorsLigne(plan, onProgres) {
  const style = await (await fetch(STYLE)).json();
  const tileJson = await (await fetch(style.sources.openmaptiles.url)).json();
  const modele = tileJson.tiles[0];
  const annexes = [
    `${MAPLIBRE}.js`,
    `${MAPLIBRE}.css`,
    ...["", "@2x"].flatMap((d) => [`${style.sprite}${d}.json`, `${style.sprite}${d}.png`]),
    ...POLICES.flatMap((p) => PLAGES_GLYPHES.map((plage) => style.glyphs.replace("{fontstack}", encodeURIComponent(p)).replace("{range}", plage))),
  ];
  const tuiles = tuilesDuTrace(plan.coords).map((t) => {
    const [z, x, y] = t.split("/");
    return modele.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  });
  const total = annexes.length + tuiles.length;
  await telecharger(annexes, onProgres, 0, total);
  const tuilesOk = await telecharger(tuiles, onProgres, annexes.length, total);
  const guidage = await preparerGuidage(plan).catch(() => false);
  return { tuiles: tuilesOk, tuilesTotal: tuiles.length, guidage };
}
