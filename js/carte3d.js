// Vue 3D de la navigation : carte vectorielle affichée par MapLibre,
// inclinée vers l'horizon, bâtiments en relief. Deux fournisseurs :
// OpenFreeMap (données OpenStreetMap, gratuit, sans clé ni quota) et TomTom
// (même clé que les itinéraires) ; si l'un est refusé, on essaie l'autre.
// Mêmes fonctions que la partie navigation de carte.js, pour que
// navigation.js puisse passer de l'une à l'autre. MapLibre n'est chargé
// qu'au premier démarrage d'une navigation en 3D.

import { getApiKeys } from "./config.js";
import { haversineKm } from "./geo.js";
import { classePuissance, puissanceBorne } from "./carte.js";
import { lireRefusTomTom } from "./tomtom.js";

const MAPLIBRE = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl";
const DELAI_CHARGEMENT_MS = 30000;
const INCLINAISON = 55;
// À échelle égale, le zoom MapLibre (tuiles 512 px) vaut celui de Leaflet
// moins 1 ; l'inclinaison éloigne l'horizon, on rapproche un peu.
const ECART_ZOOM = -0.7;
const COULEUR_RESTANT = "#22e5a0";
const COULEUR_PARCOURU = "#6b7385";
// line-gradient n'accepte qu'une expression fondée sur line-progress.
const DEGRADE_RESTANT = ["step", ["line-progress"], COULEUR_RESTANT, 1, COULEUR_RESTANT];

export const FOURNISSEURS = {
  libre: "OpenFreeMap",
  tomtom: "TomTom",
};

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
let coucheBatiments = null;
let nomFournisseur = "";
let raisonEchec = "";
let avertissement = "";
let surPanne = null;
let tuilesKoDeSuite = 0;
let horsService = false;

function chargerMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  chargementLib ??= new Promise((ok, echecBrut) => {
    const echec = (e) => {
      chargementLib = null;
      echecBrut(e);
    };
    setTimeout(() => echec(new Error("réseau trop lent pour télécharger le moteur 3D")), DELAI_CHARGEMENT_MS);
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${MAPLIBRE}.css`;
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = `${MAPLIBRE}.js`;
    script.onload = ok;
    script.onerror = () => echec(new Error("moteur 3D (MapLibre) non téléchargé : réseau ?"));
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

function urlStyle(fournisseur, sombre) {
  if (fournisseur === "tomtom") {
    return `https://api.tomtom.com/style/1/style/*?map=2/basic_street-${sombre ? "dark" : "light"}&key=${encodeURIComponent(getApiKeys().tomtom)}`;
  }
  // Style détaillé dans les deux cas ; la version nuit est calculée ici.
  return "https://tiles.openfreemap.org/styles/liberty";
}

const NOM_FRANCAIS = ["coalesce", ["get", "name:fr"], ["get", "name"], ["get", "name_en"]];

// ── Version nuit du style détaillé ─────────────────────────────────────────
// Le style sombre d'OpenFreeMap est trop pauvre (rues à peine visibles). On
// garde donc le style détaillé « liberty » et on assombrit ses couleurs :
// surfaces sombres, routes et textes clairs, teintes conservées.

function versHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function lireCouleur(texte) {
  const t = texte.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [...versHsl(n(0), n(2), n(4)), h.length === 8 ? n(6) : 1];
  }
  m = t.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [...versHsl(r / 255, g / 255, b / 255), a];
  }
  m = t.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const [h, s, l, a = "1"] = m[1].split(/[\s,/]+/).filter(Boolean);
    return [parseFloat(h), parseFloat(s) / 100, parseFloat(l) / 100, parseFloat(a)];
  }
  return null;
}

// role : "surface" (fonds, zones, bâtiments, bordures de route),
// "trait" (routes, voies ferrées, rivières), "texte", "halo".
function couleurNuit(texte, role) {
  const c = lireCouleur(texte);
  if (!c) return texte;
  const [h, s, l, a] = c;
  let nl;
  let ns = s;
  if (role === "surface") {
    nl = 0.09 + (1 - l) * 0.28;
    ns = s * 0.55;
  } else if (role === "trait") {
    nl = 0.3 + l * 0.42;
    ns = s * 0.8;
  } else if (role === "discret") {
    nl = 0.2 + l * 0.12;
    ns = s * 0.5;
  } else if (role === "texte") {
    nl = 0.93 - l * 0.35;
  } else {
    nl = 0.08;
    ns = s * 0.4;
  }
  return `hsla(${Math.round(h)}, ${Math.round(ns * 100)}%, ${Math.round(nl * 100)}%, ${a})`;
}

function convertirCouleurs(valeur, role) {
  if (typeof valeur === "string") return couleurNuit(valeur, role);
  if (Array.isArray(valeur)) return valeur.map((v) => convertirCouleurs(v, role));
  if (valeur && typeof valeur === "object") {
    const copie = { ...valeur };
    if (Array.isArray(copie.stops)) copie.stops = copie.stops.map(([z, v]) => [z, convertirCouleurs(v, role)]);
    return copie;
  }
  return valeur;
}

function styleNuit(style) {
  for (const couche of style.layers) {
    const p = couche.paint;
    if (!p) continue;
    const bordure = /casing|outline/.test(couche.id);
    // Trottoirs, chemins, pistes : utiles mais secondaires en voiture.
    const secondaire = /path|foot|pedestrian|track|steps|cycle|bridleway/.test(couche.id);
    const regles = {
      "background-color": "surface",
      "fill-color": "surface",
      "fill-outline-color": "surface",
      "fill-extrusion-color": "surface",
      "line-color": bordure ? "surface" : secondaire ? "discret" : "trait",
      "text-color": "texte",
      "text-halo-color": "halo",
      "icon-color": "texte",
    };
    for (const [prop, role] of Object.entries(regles)) if (p[prop] !== undefined) p[prop] = convertirCouleurs(p[prop], role);
    // Relief ombré en image : trop clair la nuit.
    if (couche.type === "raster") p["raster-brightness-max"] = 0.35;
    // Hachures (images claires, non recolorables) : à peine visibles.
    if (p["fill-pattern"] !== undefined) p["fill-opacity"] = 0.12;
  }
  return style;
}

// Style OpenFreeMap : noms en français (il affiche sinon l'anglais),
// bâtiments en relief s'il n'en a pas, version nuit si besoin.
function adapterStyleLibre(style, sombre) {
  if (sombre) styleNuit(style);
  for (const couche of style.layers) {
    const texte = couche.layout?.["text-field"];
    if (texte && /name/.test(JSON.stringify(texte))) couche.layout["text-field"] = NOM_FRANCAIS;
  }
  if (!style.layers.some((c) => c.type === "fill-extrusion")) {
    const avantTextes = style.layers.findIndex((c) => c.type === "symbol");
    style.layers.splice(avantTextes < 0 ? style.layers.length : avantTextes, 0, {
      id: "batiments-3d",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": sombre ? "#2b3342" : "#d8d2ca",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
  return style;
}

// Le style est téléchargé ici (et non par MapLibre) pour lire la raison
// d'un éventuel refus.
async function telechargerStyle(fournisseur, sombre) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_CHARGEMENT_MS);
  try {
    const r = await fetch(urlStyle(fournisseur, sombre), { signal: controleur.signal });
    if (!r.ok) {
      const detail = await lireRefusTomTom(r);
      throw new Error(`carte ${FOURNISSEURS[fournisseur]} refusée (HTTP ${r.status}${detail ? ` : « ${detail} »` : ""})`);
    }
    const style = await r.json();
    return fournisseur === "libre" ? adapterStyleLibre(style, sombre) : style;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`réseau trop lent pour la carte ${FOURNISSEURS[fournisseur]}`);
    if (e instanceof TypeError) throw new Error(`carte ${FOURNISSEURS[fournisseur]} inaccessible (réseau ?)`);
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}

function ajouterCouchesTrajet() {
  // Bâtiments en relief : présents mais masqués dans le style TomTom.
  coucheBatiments = carte.getStyle().layers.find((c) => c.type === "fill-extrusion")?.id || null;
  if (coucheBatiments) {
    carte.setLayoutProperty(coucheBatiments, "visibility", "visible");
    carte.setPaintProperty(coucheBatiments, "fill-extrusion-opacity", 0.85);
  }
  carte.addSource("trajet", { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true });
  // Au-dessus de toutes les routes (pointillés, tunnels, ponts compris) mais
  // sous les noms : le tracé doit rester lisible d'un coup d'œil.
  const couches = carte.getStyle().layers;
  const derniereLigne = couches.map((c) => c.type).lastIndexOf("line");
  const dessous = couches.slice(derniereLigne + 1).find((c) => c.type === "symbol")?.id;
  carte.addLayer({ id: "trajet-halo", type: "line", source: "trajet", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#062a1e", "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 17, 22] } }, dessous);
  carte.addLayer({
    id: "trajet-ligne",
    type: "line",
    source: "trajet",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 17, 14], "line-gradient": DEGRADE_RESTANT },
  }, dessous);
}

// Raison du dernier échec, affichée à l'utilisateur pour le diagnostic.
export function derniereErreur() {
  return raisonEchec;
}

// Rempli quand le fournisseur choisi a été refusé et que l'autre a pris le
// relais (à signaler, sans bloquer).
export function dernierAvertissement() {
  return avertissement;
}

// cb(raison) : la carte 3D ne peut plus s'afficher (tuiles refusées,
// moteur graphique coupé par Android) ; la navigation repasse en 2D.
export function definirSurPanne(cb) {
  surPanne = cb;
}

function panne(raison) {
  if (horsService) return;
  horsService = true;
  raisonEchec = raison;
  console.warn("[3D] Panne :", raison);
  surPanne?.(raison);
}

function surveiller() {
  carte.on("error", (e) => {
    if (!e.sourceId) return;
    // Refus en série (clé, quota, réseau coupé) : sans tuiles, la carte
    // devient noire. Une tuile ratée isolée ne suffit pas.
    if (++tuilesKoDeSuite >= 8) panne(`cartes ${nomFournisseur} refusées${e.error?.status ? `, HTTP ${e.error.status}` : ", réseau ?"}`);
  });
  carte.on("sourcedata", (e) => {
    if (e.tile) tuilesKoDeSuite = 0;
  });
  carte.on("webglcontextlost", () => panne("moteur graphique coupé par le téléphone"));
}

async function creerCarte(fournisseur, sombre) {
  const style = await telechargerStyle(fournisseur, sombre);
  if (carte) {
    carte.remove();
    carte = null;
  }
  horsService = false;
  tuilesKoDeSuite = 0;
  // Invisible mais à sa taille pendant le chargement : MapLibre a besoin
  // des dimensions, et l'écran ne reste pas noir en attendant.
  conteneur.classList.remove("hidden");
  conteneur.classList.add("ev-3d-invisible");
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
  // Seules les ressources du style (icônes, polices) sont attendues : les
  // tuiles arrivent ensuite.
  await new Promise((ok, echec) => {
    const minuteur = setTimeout(() => echec(new Error(`réseau trop lent pour la carte ${FOURNISSEURS[fournisseur]}`)), DELAI_CHARGEMENT_MS);
    carte.once("style.load", () => {
      clearTimeout(minuteur);
      ok();
    });
  });
  ajouterCouchesTrajet();
  carte.on("dragstart", (e) => e.originalEvent && surDeplacementManuel?.());
  carte.on("zoomstart", (e) => e.originalEvent && surDeplacementManuel?.());
  surveiller();
  nomFournisseur = FOURNISSEURS[fournisseur];
}

// Prépare la carte 3D avec le fournisseur préféré, sinon l'autre. Renvoie
// false si aucun ne marche : la navigation reste alors en 2D.
export async function preparer({ sombre = true, fournisseur = "libre" } = {}) {
  avertissement = "";
  if (!webglDisponible()) {
    raisonEchec = "WebGL absent sur ce navigateur";
    return false;
  }
  conteneur = document.getElementById("ev-carte-3d");
  try {
    await chargerMapLibre();
  } catch (e) {
    raisonEchec = e.message;
    return false;
  }
  const ordre = [fournisseur, fournisseur === "tomtom" ? "libre" : "tomtom"].filter((f) => f !== "tomtom" || getApiKeys().tomtom);
  const echecs = [];
  for (const f of ordre) {
    const cleStyle = `${f}-${sombre}`;
    if (carte && styleCharge === cleStyle && !horsService) return true;
    try {
      await creerCarte(f, sombre);
      styleCharge = cleStyle;
      raisonEchec = "";
      if (echecs.length) avertissement = `${echecs.join(" ; ")} : carte ${FOURNISSEURS[f]} utilisée à la place`;
      conteneur.classList.add("hidden");
      conteneur.classList.remove("ev-3d-invisible");
      return true;
    } catch (e) {
      echecs.push(e.message || String(e));
      console.warn("[3D]", e.message || e);
    }
  }
  raisonEchec = echecs.join(" ; ") || "aucune carte 3D disponible";
  if (carte) carte.remove();
  carte = null;
  styleCharge = null;
  conteneur.classList.add("hidden");
  conteneur.classList.remove("ev-3d-invisible");
  return false;
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
