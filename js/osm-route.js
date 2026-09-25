// Radars fixes et feux tricolores le long d'un itinéraire, d'après
// OpenStreetMap (service Overpass, gratuit, sans clé).

import { interrogerOverpass } from "./parkings.js";
import { haversineKm } from "./geo.js";

// Un point tous les `pasM` mètres : une ligne « around » de milliers de
// points ralentirait Overpass.
function allegerM(coords, pasM) {
  if (coords.length < 2) return coords;
  const garde = [coords[0]];
  let cumul = 0;
  for (let i = 1; i < coords.length; i++) {
    cumul += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]) * 1000;
    if (cumul >= pasM) {
      garde.push(coords[i]);
      cumul = 0;
    }
  }
  if (garde[garde.length - 1] !== coords[coords.length - 1]) garde.push(coords[coords.length - 1]);
  return garde;
}

const ligne = (pts) => pts.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",");

// Radars fixes près du tracé : recherche par petits rectangles (~15 km de
// route chacun), bien plus rapide pour Overpass qu'une longue ligne ; le
// tri fin (à moins de 40 m de la route) se fait ensuite. Renvoie
// { ok, radars } ou { ok: false, erreur }.
const POINTS_PAR_RECTANGLE = 100;
const MARGE_RECTANGLE_DEG = 0.001;

export async function radarsLeLongDu(coords) {
  const pts = allegerM(coords, 150);
  const rectangles = [];
  for (let i = 0; i < pts.length - 1; i += POINTS_PAR_RECTANGLE) {
    const m = pts.slice(i, i + POINTS_PAR_RECTANGLE + 1);
    const lats = m.map((p) => p[1]);
    const lons = m.map((p) => p[0]);
    const f = (x) => x.toFixed(4);
    rectangles.push(`${f(Math.min(...lats) - MARGE_RECTANGLE_DEG)},${f(Math.min(...lons) - MARGE_RECTANGLE_DEG)},${f(Math.max(...lats) + MARGE_RECTANGLE_DEG)},${f(Math.max(...lons) + MARGE_RECTANGLE_DEG)}`);
  }
  const requete = `[out:json][timeout:25];(${rectangles.map((b) => `node["highway"="speed_camera"](${b});`).join("")});out;`;
  const r = await interrogerOverpass(requete);
  return r.ok ? { ok: true, radars: r.elements.map((e) => ({ lat: e.lat, lon: e.lon })) } : r;
}

// Feux tricolores à moins de 20 m des morceaux de tracé donnés ([lon, lat][]).
export async function feuxLeLongDe(morceaux) {
  const utiles = morceaux.filter((m) => m.length >= 2);
  if (!utiles.length) return { ok: true, feux: [] };
  const requete = `[out:json][timeout:25];(${utiles.map((m) => `node["highway"="traffic_signals"](around:20,${ligne(m)});`).join("")});out;`;
  const r = await interrogerOverpass(requete);
  return r.ok ? { ok: true, feux: r.elements.map((e) => ({ lat: e.lat, lon: e.lon })) } : r;
}
