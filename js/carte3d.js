// Vue 3D de la navigation : carte vectorielle TomTom (même clé que les
// itinéraires) affichée par MapLibre, inclinée vers l'horizon, bâtiments en
// relief. Mêmes fonctions que la partie navigation de carte.js, pour que
// navigation.js puisse passer de l'une à l'autre. MapLibre n'est chargé
// qu'au premier démarrage d'une navigation en 3D.

import { getApiKeys } from "./config.js";
import { haversineKm } from "./geo.js";
import { classePuissance, puissanceBorne } from "./carte.js";

const MAPLIBRE = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl";
const DELAI_CHARGEMENT_MS = 15000;
const INCLINAISON = 55;
// À échelle égale, le zoom MapLibre (tuiles 512 px) vaut celui de Leaflet
// moins 1 ; l'inclinaison éloigne l'horizon, on rapproche un peu.
const ECART_ZOOM = -0.7;
const COULEUR_RESTANT = "#22e5a0";
const COULEUR_PARCOURU = "#6b7385";
// line-gradient n'accepte qu'une expression fondée sur line-progress.
const DEGRADE_RESTANT = ["step", ["line-progress"], COULEUR_RESTANT, 1, COULEUR_RESTANT];

let carte = null;
let styleCharge = null;
let chargementLib = null;
let conteneur = null;
let voiture = null;
let marqueursRoute = [];
let marqueursBornes = [];
let bornesVisibles = false;
let cumRoute = null;
let surDeplacementManuel = null;

function chargerMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  chargementLib ??= new Promise((ok, echec) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${MAPLIBRE}.css`;
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = `${MAPLIBRE}.js`;
    script.onload = ok;
    script.onerror = () => {
      chargementLib = null;
      echec(new Error("MapLibre indisponible (réseau ?)"));
    };
    document.head.appendChild(script);
  });
  return chargementLib;
}

function webglDisponible() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function urlStyle(sombre) {
  const cle = encodeURIComponent(getApiKeys().tomtom);
  return `https://api.tomtom.com/style/1/style/*?map=2/basic_street-${sombre ? "dark" : "light"}&key=${cle}`;
}

function ajouterCouchesTrajet() {
  // Bâtiments en relief : présents dans le style TomTom mais masqués.
  if (carte.getLayer("3D - Building")) {
    carte.setLayoutProperty("3D - Building", "visibility", "visible");
    carte.setPaintProperty("3D - Building", "fill-extrusion-opacity", 0.85);
  }
  carte.addSource("trajet", { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true });
  const dessus = carte.getLayer("3D - Building") ? "3D - Building" : undefined;
  carte.addLayer({ id: "trajet-halo", type: "line", source: "trajet", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#062a1e", "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 17, 22] } }, dessus);
  carte.addLayer({
    id: "trajet-ligne",
    type: "line",
    source: "trajet",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 17, 14], "line-gradient": DEGRADE_RESTANT },
  }, dessus);
}

// Prépare la carte 3D (bibliothèque, style TomTom). Renvoie false si ce
// n'est pas possible : la navigation reste alors en 2D.
export async function preparer({ sombre = true } = {}) {
  if (!getApiKeys().tomtom || !webglDisponible()) return false;
  try {
    await chargerMapLibre();
    conteneur = document.getElementById("ev-carte-3d");
    const style = urlStyle(sombre);
    if (carte && styleCharge === style) return true;
    if (carte) {
      carte.remove();
      carte = null;
    }
    conteneur.classList.remove("hidden");
    carte = new maplibregl.Map({
      container: conteneur,
      style,
      center: [2.4, 46.6],
      zoom: 5,
      pitch: INCLINAISON,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    });
    await new Promise((ok, echec) => {
      const minuteur = setTimeout(() => echec(new Error("style TomTom trop long à charger")), DELAI_CHARGEMENT_MS);
      carte.once("load", () => {
        clearTimeout(minuteur);
        ok();
      });
      carte.once("error", (e) => {
        if (!carte.isStyleLoaded()) {
          clearTimeout(minuteur);
          echec(e.error || new Error("style TomTom refusé"));
        }
      });
    });
    ajouterCouchesTrajet();
    carte.on("dragstart", (e) => e.originalEvent && surDeplacementManuel?.());
    carte.on("zoomstart", (e) => e.originalEvent && surDeplacementManuel?.());
    styleCharge = style;
    conteneur.classList.add("hidden");
    return true;
  } catch (e) {
    console.warn("[3D] Vue 3D indisponible, navigation en 2D", e);
    if (carte) carte.remove();
    carte = null;
    styleCharge = null;
    conteneur?.classList.add("hidden");
    return false;
  }
}

function iconeVoiture() {
  const el = document.createElement("div");
  el.innerHTML = `<svg width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="26" fill="rgba(61,139,255,0.22)"/><path d="M28 8 L42 44 L28 36 L14 44 Z" fill="#3d8bff" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/></svg>`;
  return el;
}

function pastille(taille, couleur, contenu = "") {
  const el = document.createElement("div");
  el.innerHTML = `<div class="ev-point-trajet" style="width:${taille}px;height:${taille}px;background:${couleur};box-shadow:0 0 12px ${couleur};">${contenu}</div>`;
  return el;
}

export function entrerNavigation({ onDeplacementManuel } = {}) {
  surDeplacementManuel = onDeplacementManuel;
  conteneur.classList.remove("hidden");
  carte.resize();
}

export function quitterNavigation() {
  surDeplacementManuel = null;
  for (const m of [...marqueursRoute, ...marqueursBornes]) m.remove();
  marqueursRoute = [];
  marqueursBornes = [];
  voiture?.remove();
  voiture = null;
  conteneur?.classList.add("hidden");
}

export function dessinerRouteNavigation(coords, arrets, destination) {
  cumRoute = [0];
  for (let i = 1; i < coords.length; i++) cumRoute.push(cumRoute[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  carte.getSource("trajet").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
  carte.setPaintProperty("trajet-ligne", "line-gradient", DEGRADE_RESTANT);
  for (const m of marqueursRoute) m.remove();
  marqueursRoute = (arrets || []).map((a) => new maplibregl.Marker({ element: pastille(32, "rgba(79,224,255,.95)", "🔋") }).setLngLat([a.lon, a.lat]).addTo(carte));
  if (destination) marqueursRoute.push(new maplibregl.Marker({ element: pastille(26, "#ff6b35", "🏁") }).setLngLat([destination.lon, destination.lat]).addTo(carte));
}

// Parcouru en gris, restant en vert : un dégradé à seuil le long du tracé,
// bien moins coûteux que de redécouper la ligne plusieurs fois par seconde.
export function majProgressionNavigation(coords, indice, lat, lon) {
  if (!cumRoute?.length || !coords[indice]) return;
  const total = cumRoute[cumRoute.length - 1];
  if (total <= 0) return;
  const fait = cumRoute[indice] + haversineKm(coords[indice][1], coords[indice][0], lat, lon);
  const f = Math.min(0.9999, Math.max(0.0001, fait / total));
  carte.setPaintProperty("trajet-ligne", "line-gradient", ["step", ["line-progress"], COULEUR_PARCOURU, f, COULEUR_RESTANT]);
}

export function majVoiture(lat, lon, cap) {
  if (!voiture) {
    voiture = new maplibregl.Marker({ element: iconeVoiture(), rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([lon, lat]).addTo(carte);
  } else {
    voiture.setLngLat([lon, lat]);
  }
  voiture.setRotation(cap || 0);
}

// Voiture vers le bas de l'écran pour voir loin devant ; en « nord en
// haut », la carte reste inclinée mais ne tourne plus.
export function cameraNavigation(lat, lon, cap, zoom, sensDeMarche, anime = true) {
  const hauteur = carte.getContainer().clientHeight;
  const vue = {
    center: [lon, lat],
    zoom: zoom + ECART_ZOOM,
    bearing: sensDeMarche ? cap || 0 : 0,
    pitch: INCLINAISON,
    padding: { top: hauteur * 0.42, bottom: 0, left: 0, right: 0 },
  };
  if (anime) carte.easeTo({ ...vue, duration: 600 });
  else carte.jumpTo(vue);
}

export function apercuNavigation(coords) {
  if (!coords?.length) return;
  const limites = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  // Le décalage « voiture en bas » de cameraNavigation reste sinon appliqué.
  carte.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  carte.fitBounds(limites, { bearing: 0, pitch: 0, padding: { top: 190, bottom: 150, left: 40, right: 40 }, duration: 800 });
}

function iconeBorne(b) {
  const kw = puissanceBorne(b);
  const cb = b.officiel && !b.officiel.indisponible && ["oui", "partiel"].includes(b.officiel.paiement_cb);
  const el = document.createElement("div");
  el.className = "ev-pin-3d";
  el.innerHTML = `<div class="ev-pin ${classePuissance(kw)}"><span>${kw || "?"}</span>${cb ? '<b class="ev-pin-cb">CB</b>' : ""}</div>`;
  return el;
}

export function afficherBornes(bornes, onClic) {
  for (const m of marqueursBornes) m.remove();
  marqueursBornes = bornes.map((b) => {
    const el = iconeBorne(b);
    el.addEventListener("click", () => onClic(b));
    return new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([b.lon, b.lat]);
  });
  if (bornesVisibles) for (const m of marqueursBornes) m.addTo(carte);
}

export function montrerBornes(visible) {
  bornesVisibles = visible;
  for (const m of marqueursBornes) {
    if (visible) m.addTo(carte);
    else m.remove();
  }
}
