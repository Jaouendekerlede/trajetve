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
// Dernier tracé de navigation : à redessiner si la carte est recréée en
// route (changement de fond au coucher du soleil, par exemple).
let traceNav = null;
let surDeplacementManuel = null;
let coucheBatiments = null;
let nomFournisseur = "";
let raisonEchec = "";
let avertissement = "";
const surPannes = new Set();
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

// Fond satellite (images Esri, sans clé, comme en 2D) : pas de bâtiments,
// mais routes et noms de lieux par-dessus.
function styleSatellite() {
  const esri = (chemin) => ({ type: "raster", tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/${chemin}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19 });
  return {
    version: 8,
    sources: {
      images: { ...esri("World_Imagery"), attribution: "Imagerie © Esri" },
      routes: esri("Reference/World_Transportation"),
      lieux: esri("Reference/World_Boundaries_and_Places"),
    },
    layers: [
      { id: "images", type: "raster", source: "images" },
      { id: "routes", type: "raster", source: "routes" },
      { id: "lieux", type: "raster", source: "lieux" },
    ],
  };
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

// Nos tracés vont au-dessus de toutes les routes du fond (pointillés,
// tunnels, ponts compris) mais sous les noms : lisibles d'un coup d'œil.
function coucheSousLesNoms() {
  const couches = carte.getStyle().layers;
  const derniereLigne = couches.map((c) => c.type).lastIndexOf("line");
  return couches.slice(derniereLigne + 1).find((c) => c.type === "symbol")?.id;
}

function ajouterCouchesTrajet() {
  // Bâtiments en relief : présents mais masqués dans le style TomTom.
  coucheBatiments = carte.getStyle().layers.find((c) => c.type === "fill-extrusion")?.id || null;
  if (coucheBatiments) {
    carte.setLayoutProperty(coucheBatiments, "visibility", "visible");
    carte.setPaintProperty(coucheBatiments, "fill-extrusion-opacity", 0.85);
  }
  carte.addSource("trajet", { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true });
  const dessous = coucheSousLesNoms();
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
  surPannes.add(cb);
}

function panne(raison) {
  if (horsService) return;
  horsService = true;
  raisonEchec = raison;
  console.warn("[3D] Panne :", raison);
  for (const cb of surPannes) cb(raison);
}

// Relief du terrain : altitudes « Terrain Tiles » (données ouvertes
// hébergées par AWS, sans clé). Un peu exagéré pour être perceptible.
const TUILES_RELIEF = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
let reliefKo = 0;

function ajouterRelief() {
  reliefKo = 0;
  carte.addSource("relief", { type: "raster-dem", tiles: [TUILES_RELIEF], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: "Relief : Terrain Tiles (AWS)" });
  carte.setTerrain({ source: "relief", exaggeration: 1.3 });
}

function surveiller() {
  carte.on("error", (e) => {
    if (!e.sourceId) return;
    // Relief indisponible : on s'en passe, la carte reste utilisable.
    if (e.sourceId === "relief") {
      if (++reliefKo >= 5 && carte.getTerrain()) {
        console.warn("[3D] Relief indisponible, carte à plat");
        carte.setTerrain(null);
      }
      return;
    }
    // Refus en série (clé, quota, réseau coupé) : sans tuiles, la carte
    // devient noire. Une tuile ratée isolée ne suffit pas.
    if (++tuilesKoDeSuite >= 8) panne(`cartes ${nomFournisseur} refusées${e.error?.status ? `, HTTP ${e.error.status}` : ", réseau ?"}`);
  });
  carte.on("sourcedata", (e) => {
    if (e.tile && e.sourceId !== "relief") tuilesKoDeSuite = 0;
  });
  carte.on("webglcontextlost", () => panne("moteur graphique coupé par le téléphone"));
  // Le style OpenFreeMap cite quelques icônes absentes de son catalogue :
  // image vide plutôt qu'un avertissement par icône.
  carte.on("styleimagemissing", (e) => {
    if (!carte.hasImage(e.id)) carte.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
}

async function creerCarte(fournisseur, fond, relief) {
  const style = fond === "satellite" ? styleSatellite() : await telechargerStyle(fournisseur, fond === "sombre");
  // Changement de style en cours d'exploration : on garde le même cadrage.
  const vueAvant = carte ? { center: carte.getCenter(), zoom: carte.getZoom(), pitch: carte.getPitch(), bearing: carte.getBearing() } : null;
  if (carte) {
    for (const m of [...explo.marqueursBornes.values(), ...explo.grappes]) m.remove();
    explo.grappes = [];
    for (const m of [...explo.marqueursTrajet, explo.marqueurPosition, explo.marqueurCurseur]) m?.remove();
    explo.marqueurPosition = null;
    explo.marqueurCurseur = null;
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
  ajouterCouchesExplo();
  if (relief && fond !== "satellite") ajouterRelief();
  carte.on("dragstart", (e) => e.originalEvent && surDeplacementManuel?.());
  carte.on("zoomstart", (e) => e.originalEvent && surDeplacementManuel?.());
  surveiller();
  nomFournisseur = fond === "satellite" ? "satellite Esri" : FOURNISSEURS[fournisseur];
  if (vueAvant) carte.jumpTo(vueAvant);
  if (enNavigation) {
    if (traceNav) dessinerRouteNavigation(...traceNav);
    voiture?.addTo(carte);
    if (bornesVisibles) for (const m of marqueursBornes) m.addTo(carte);
  }
  if (explo.actif) {
    gestesExploration(!enNavigation);
    rendreExplo();
  }
}

// Prépare la carte 3D avec le fournisseur préféré, sinon l'autre. Renvoie
// false si aucun ne marche : la navigation reste alors en 2D.
// Les préparations s'exécutent l'une après l'autre : deux changements de
// fond rapprochés ne doivent pas se croiser (le dernier demandé l'emporte).
let fileAttente = Promise.resolve();

export function preparer(options) {
  const suite = fileAttente.then(() => preparerMaintenant(options));
  fileAttente = suite.catch(() => {});
  return suite;
}

async function preparerMaintenant({ sombre = true, fond = sombre ? "sombre" : "plan", fournisseur = "libre", relief = false } = {}) {
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
  // Le satellite ne dépend pas du fournisseur de carte vectorielle.
  const ordre = fond === "satellite" ? ["satellite"] : [fournisseur, fournisseur === "tomtom" ? "libre" : "tomtom"].filter((f) => f !== "tomtom" || getApiKeys().tomtom);
  const echecs = [];
  for (const f of ordre) {
    const cleStyle = `${f}-${fond}-${relief}`;
    if (carte && styleCharge === cleStyle && !horsService) return true;
    try {
      await creerCarte(f, fond, relief);
      styleCharge = cleStyle;
      raisonEchec = "";
      if (echecs.length) avertissement = `${echecs.join(" ; ")} : carte ${FOURNISSEURS[f]} utilisée à la place`;
      // Reste affichée si la carte des bornes est déjà en 3D.
      if (!explo.actif && !enNavigation) conteneur.classList.add("hidden");
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

// ── Carte des bornes en 3D (exploration) ────────────────────────────────────
// carte.js transmet ici toutes les données affichées (bornes, trajet…), même
// quand la 3D est éteinte : à l'allumage, tout est déjà connu. Pendant une
// navigation 3D, ces éléments sont masqués puis rétablis à la fin.

const INCLINAISON_EXPLO = 50;
const SANS_MARGE = { top: 0, left: 0, right: 0, bottom: 0 };
const VIDE = { type: "FeatureCollection", features: [] };
const COUCHES_EXPLO = ["alt-ligne", "alt-zone", "plan-halo", "plan-aller", "plan-retour"];

const explo = {
  actif: false,
  onDeplacement: null,
  decalageBas: 0,
  vue: null,
  bornes: [],
  onClicBorne: null,
  bornesVisibles: true,
  selection: null,
  marqueursBornes: new Map(),
  grappes: [],
  position: null,
  marqueurPosition: null,
  trajet: null,
  onClicArret: null,
  marqueursTrajet: [],
  alternatives: [],
  curseur: null,
  marqueurCurseur: null,
};
let enNavigation = false;

function ajouterCouchesExplo() {
  carte.addSource("plan", { type: "geojson", data: VIDE });
  carte.addSource("plan-alternatives", { type: "geojson", data: VIDE });
  const dessous = coucheSousLesNoms();
  const rond = { "line-cap": "round", "line-join": "round" };
  carte.addLayer({ id: "alt-ligne", type: "line", source: "plan-alternatives", layout: rond, paint: { "line-color": "#7d8797", "line-width": 5, "line-opacity": 0.8 } }, dessous);
  // Zone de toucher bien plus large que le trait (doigt sur téléphone).
  carte.addLayer({ id: "alt-zone", type: "line", source: "plan-alternatives", layout: rond, paint: { "line-color": "#000000", "line-width": 26, "line-opacity": 0.01 } }, dessous);
  const filtre = (type) => ["==", ["get", "type"], type];
  carte.addLayer({ id: "plan-halo", type: "line", source: "plan", filter: filtre("aller"), layout: rond, paint: { "line-color": "#04221a", "line-width": 11, "line-opacity": 0.35 } }, dessous);
  carte.addLayer({ id: "plan-aller", type: "line", source: "plan", filter: filtre("aller"), layout: rond, paint: { "line-color": "#22e5a0", "line-width": 6, "line-opacity": 0.95 } }, dessous);
  carte.addLayer({ id: "plan-retour", type: "line", source: "plan", filter: filtre("retour"), paint: { "line-color": "#ffb400", "line-width": 4, "line-opacity": 0.85, "line-dasharray": [2, 2] } }, dessous);
  carte.on("click", "alt-zone", (e) => explo.alternatives[e.features?.[0]?.properties?.i]?.onClic?.());
  carte.on("moveend", () => {
    if (!explo.actif || enNavigation) return;
    explo.vue = vueExplo();
    // Distances à l'écran changées (zoom, rotation, inclinaison) : regrouper à nouveau.
    rendreBornes();
    explo.onDeplacement?.();
  });
}

function vueExplo() {
  const c = carte.getCenter();
  return { lat: c.lat, lon: c.lng, zoom: carte.getZoom() - ECART_ZOOM_EXPLO };
}

// Zooms de l'interface exprimés à l'échelle Leaflet (tuiles 256 px).
const ECART_ZOOM_EXPLO = -1;

function gestesExploration(actifs) {
  const action = actifs ? "enable" : "disable";
  carte.dragRotate[action]();
  carte.touchPitch[action]();
  if (actifs) carte.touchZoomRotate.enableRotation();
  else carte.touchZoomRotate.disableRotation();
}

function marqueur(element, lat, lon, options = {}) {
  return new maplibregl.Marker({ element, ...options }).setLngLat([lon, lat]);
}

function afficherSiVisible(m, visible = true) {
  if (visible && explo.actif && !enNavigation && carte) m.addTo(carte);
  return m;
}

function rendreBorne(b) {
  explo.marqueursBornes.get(b)?.remove();
  const el = iconeBorne(b, b === explo.selection);
  el.style.zIndex = String(puissanceBorne(b) * 2 + (b === explo.selection ? 10000 : 0));
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    explo.onClicBorne?.(b);
  });
  explo.marqueursBornes.set(b, afficherSiVisible(marqueur(el, b.lat, b.lon, { anchor: "bottom" }), explo.bornesVisibles));
}

// Bornes qui se chevaucheraient à l'écran : un seul rond « nombre », de la
// couleur de la plus puissante ; le toucher rapproche la carte. Comme en 2D,
// plus de regroupement à partir du zoom 16, et la sélection reste à part.
const RAYON_GRAPPE_PX = 42;
const ZOOM_SANS_REGROUPEMENT = 16;

function grappe(groupe) {
  const kwMax = Math.max(0, ...groupe.map(puissanceBorne));
  const lat = groupe.reduce((s, b) => s + b.lat, 0) / groupe.length;
  const lon = groupe.reduce((s, b) => s + b.lon, 0) / groupe.length;
  const el = document.createElement("div");
  el.className = `ev-grappe ${classePuissance(kwMax)}`;
  el.textContent = String(groupe.length);
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    carte.easeTo({ center: [lon, lat], zoom: carte.getZoom() + 2, duration: 500 });
  });
  return afficherSiVisible(marqueur(el, lat, lon), explo.bornesVisibles);
}

function rendreBornes() {
  for (const m of explo.marqueursBornes.values()) m.remove();
  explo.marqueursBornes.clear();
  for (const m of explo.grappes) m.remove();
  explo.grappes = [];
  if (!carte) return;
  const seules = [];
  const autres = explo.bornes.filter((b) => b !== explo.selection);
  if (explo.selection && explo.bornes.includes(explo.selection)) seules.push(explo.selection);
  if (exploZoom() >= ZOOM_SANS_REGROUPEMENT) {
    seules.push(...autres);
  } else {
    const points = autres.map((b) => ({ b, p: carte.project([b.lon, b.lat]) })).sort((x, y) => puissanceBorne(y.b) - puissanceBorne(x.b));
    const pris = new Set();
    for (let i = 0; i < points.length; i++) {
      if (pris.has(i)) continue;
      pris.add(i);
      const groupe = [points[i].b];
      for (let j = i + 1; j < points.length; j++) {
        if (!pris.has(j) && Math.hypot(points[i].p.x - points[j].p.x, points[i].p.y - points[j].p.y) < RAYON_GRAPPE_PX) {
          pris.add(j);
          groupe.push(points[j].b);
        }
      }
      if (groupe.length === 1) seules.push(groupe[0]);
      else explo.grappes.push(grappe(groupe));
    }
  }
  for (const b of seules) rendreBorne(b);
}

function rendrePosition() {
  explo.marqueurPosition?.remove();
  explo.marqueurPosition = null;
  if (!carte || !explo.position) return;
  const el = document.createElement("div");
  el.innerHTML = '<div class="ev-position"></div>';
  explo.marqueurPosition = afficherSiVisible(marqueur(el, explo.position.lat, explo.position.lon));
}

function rendreCurseur() {
  explo.marqueurCurseur?.remove();
  explo.marqueurCurseur = null;
  if (!carte || !explo.curseur) return;
  const el = pastille(22, "rgba(0,229,255,.95)");
  el.classList.add("ev-curseur-3d");
  el.insertAdjacentHTML("beforeend", `<span class="ev-curseur-3d-texte"></span>`);
  el.querySelector(".ev-curseur-3d-texte").textContent = explo.curseur.label || "Position estimée";
  explo.marqueurCurseur = afficherSiVisible(marqueur(el, explo.curseur.lat, explo.curseur.lon));
}

function rendreAlternatives() {
  if (!carte) return;
  const features = explo.alternatives
    .map((a, i) => (a.coords?.length ? { type: "Feature", properties: { i }, geometry: { type: "LineString", coordinates: a.coords } } : null))
    .filter(Boolean);
  carte.getSource("plan-alternatives").setData({ type: "FeatureCollection", features });
}

function marqueurArret(arret, taille, couleur, titre) {
  const el = pastille(taille, couleur, "🔋");
  el.title = titre;
  el.style.cursor = "pointer";
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    explo.onClicArret?.(arret);
  });
  return marqueur(el, arret.lat, arret.lon);
}

function rendreTrajet(recadrer) {
  for (const m of explo.marqueursTrajet) m.remove();
  explo.marqueursTrajet = [];
  if (!carte) return;
  const d = explo.trajet;
  if (!d?.coords?.length) {
    carte.getSource("plan").setData(VIDE);
    return;
  }
  const features = [{ type: "Feature", properties: { type: "aller" }, geometry: { type: "LineString", coordinates: d.coords } }];
  const limites = d.coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(d.coords[0], d.coords[0]));
  const m = [];
  if (d.retour?.ok && d.retour.coords?.length) {
    features.push({ type: "Feature", properties: { type: "retour" }, geometry: { type: "LineString", coordinates: d.retour.coords } });
    for (const c of d.retour.coords) limites.extend(c);
    for (const a of d.retour.arrets || []) if (a.lat !== undefined) m.push(marqueurArret(a, 24, "rgba(255,180,0,.95)", `Retour : ${a.nom_borne || "Borne"}`));
  }
  carte.getSource("plan").setData({ type: "FeatureCollection", features });
  if (d.from_lat !== undefined) {
    const el = pastille(18, "#22e5a0");
    el.title = d.from_name || "Départ";
    m.push(marqueur(el, d.from_lat, d.from_lon));
  }
  if (d.to_lat !== undefined) {
    const el = pastille(22, "#ff6b35", "🏁");
    el.title = d.to_name || "Arrivée";
    m.push(marqueur(el, d.to_lat, d.to_lon));
  }
  (d.arrets || []).forEach((a, i) => a.lat !== undefined && m.push(marqueurArret(a, 30, "rgba(79,224,255,.95)", `Arrêt ${i + 1} : ${a.nom_borne || "Borne"}`)));
  explo.marqueursTrajet = m.map((x) => afficherSiVisible(x));
  if (recadrer && explo.actif && !enNavigation) {
    carte.fitBounds(limites, { padding: { top: 130, bottom: explo.decalageBas + 30, left: 30, right: 30 }, duration: 700, maxZoom: 16 });
  }
}

function rendreExplo() {
  rendreBornes();
  rendrePosition();
  rendreCurseur();
  rendreAlternatives();
  rendreTrajet(false);
}

// Masque (navigation) ou rétablit les éléments de la carte des bornes.
function montrerElementsExplo(visible) {
  if (!carte) return;
  for (const id of COUCHES_EXPLO) if (carte.getLayer(id)) carte.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  const marqueurs = [...explo.marqueursTrajet, explo.marqueurPosition, explo.marqueurCurseur].filter(Boolean);
  if (explo.bornesVisibles) marqueurs.push(...explo.marqueursBornes.values(), ...explo.grappes);
  for (const m of marqueurs) {
    if (visible) m.addTo(carte);
    else m.remove();
  }
}

export function activerExploration({ lat, lon, zoom, onDeplacement, decalageBas = 0 }) {
  explo.actif = true;
  explo.onDeplacement = onDeplacement;
  explo.decalageBas = decalageBas;
  conteneur.classList.remove("hidden");
  carte.resize();
  gestesExploration(true);
  carte.jumpTo({ center: [lon, lat], zoom: zoom + ECART_ZOOM_EXPLO, pitch: INCLINAISON_EXPLO, bearing: 0, padding: SANS_MARGE });
  explo.vue = vueExplo();
  rendreExplo();
}

// Renvoie le cadrage courant (échelle Leaflet) pour que la 2D reprenne au même endroit.
export function desactiverExploration() {
  const vue = carte ? vueExplo() : explo.vue;
  explo.actif = false;
  montrerElementsExplo(false);
  if (!enNavigation) conteneur?.classList.add("hidden");
  return vue;
}

// Carte 2D en navigation alors que la carte des bornes est en 3D : la 3D
// doit s'effacer pour laisser voir la 2D, puis revenir.
export function masquerExploration(masquer) {
  if (!explo.actif) return;
  conteneur.classList.toggle("hidden", masquer);
  if (!masquer) carte?.resize();
}

// Simple mémorisation : modifier la caméra ici interromprait un cadrage en
// cours (le panneau change de hauteur juste après l'affichage d'un trajet).
export function exploDecalageBas(px) {
  explo.decalageBas = px;
}

// Centre de la partie visible, au-dessus du panneau.
export function exploCentreVisible() {
  const { width, height } = carte.getCanvas().getBoundingClientRect();
  const c = carte.unproject([width / 2, Math.max(1, (height - explo.decalageBas) / 2)]);
  return { lat: c.lat, lon: c.lng };
}

// Carte inclinée : on mesure vers le bas de l'écran (côté proche), l'horizon
// donnerait un rayon démesuré.
export function exploRayonVisibleKm() {
  const { width, height } = carte.getCanvas().getBoundingClientRect();
  const c = exploCentreVisible();
  const coin = carte.unproject([width, Math.max(1, height - explo.decalageBas)]);
  return Math.min(30, haversineKm(c.lat, c.lon, coin.lat, coin.lng) * 1.2);
}

export function exploZoom() {
  return carte.getZoom() - ECART_ZOOM_EXPLO;
}

export function exploCentrer(lat, lon, zoom) {
  // Comme en 2D : le point visé se place au centre de la partie visible.
  carte.easeTo({ center: [lon, lat], zoom: (zoom ?? exploZoom()) + ECART_ZOOM_EXPLO, padding: SANS_MARGE, offset: [0, -explo.decalageBas / 2], duration: 600 });
}

export function exploBornes(bornes, onClic) {
  explo.bornes = bornes;
  explo.onClicBorne = onClic;
  rendreBornes();
}

export function exploRafraichirBorne(b) {
  if (carte && explo.marqueursBornes.has(b)) rendreBorne(b);
}

// La sélection sort de son groupe : on regroupe à nouveau.
export function exploSelection(b) {
  explo.selection = b;
  rendreBornes();
}

export function exploMontrerBornes(visible) {
  explo.bornesVisibles = visible;
  for (const m of [...explo.marqueursBornes.values(), ...explo.grappes]) {
    if (visible && explo.actif && !enNavigation && carte) m.addTo(carte);
    else m.remove();
  }
}

export function exploPosition(lat, lon) {
  explo.position = { lat, lon };
  if (explo.marqueurPosition) explo.marqueurPosition.setLngLat([lon, lat]);
  else rendrePosition();
}

export function exploTrajet(data, onClicArret) {
  explo.trajet = data;
  explo.onClicArret = onClicArret;
  explo.curseur = null;
  explo.alternatives = [];
  rendreCurseur();
  rendreAlternatives();
  rendreTrajet(true);
}

export function exploAlternatives(liste) {
  explo.alternatives = liste;
  rendreAlternatives();
}

export function exploEffacerTrajet() {
  explo.trajet = null;
  explo.curseur = null;
  explo.alternatives = [];
  rendreTrajet(false);
  rendreCurseur();
  rendreAlternatives();
}

export function exploCurseur(lat, lon, label) {
  explo.curseur = lat === undefined || lon === undefined ? null : { lat, lon, label };
  rendreCurseur();
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
  enNavigation = true;
  montrerElementsExplo(false);
  gestesExploration(false);
  conteneur.classList.remove("hidden");
  carte.resize();
}

export function quitterNavigation() {
  surDeplacementManuel = null;
  enNavigation = false;
  for (const m of [...marqueursRoute, ...marqueursBornes]) m.remove();
  marqueursRoute = [];
  marqueursBornes = [];
  voiture?.remove();
  voiture = null;
  traceNav = null;
  if (!carte) return;
  carte.getSource("trajet")?.setData(VIDE);
  if (explo.actif) {
    // Retour à la carte des bornes, telle qu'elle était.
    montrerElementsExplo(true);
    gestesExploration(true);
    const v = explo.vue;
    carte.jumpTo({ pitch: INCLINAISON_EXPLO, bearing: 0, padding: SANS_MARGE, ...(v ? { center: [v.lon, v.lat], zoom: v.zoom + ECART_ZOOM_EXPLO } : {}) });
  } else {
    conteneur?.classList.add("hidden");
  }
}

export function dessinerRouteNavigation(coords, arrets, destination) {
  traceNav = [coords, arrets, destination];
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

function iconeBorne(b, selectionnee = false) {
  const kw = puissanceBorne(b);
  const cb = b.officiel && !b.officiel.indisponible && ["oui", "partiel"].includes(b.officiel.paiement_cb);
  const el = document.createElement("div");
  el.className = "ev-pin-3d";
  el.innerHTML = `<div class="ev-pin ${classePuissance(kw)}${selectionnee ? " selection" : ""}"><span>${kw || "?"}</span>${cb ? '<b class="ev-pin-cb">CB</b>' : ""}</div>`;
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
