// Carte plein écran : fonds (sombre / plan / satellite), épingles de bornes
// colorées selon la puissance, position de l'utilisateur, itinéraire (aller
// vert, retour orange pointillé, arrêts 🔋) et curseur "où serai-je ?".
// Le panneau coulissant cache le bas de la carte : `decalageBas` permet de
// centrer et cadrer dans la partie réellement visible.

import { escapeHtml } from "./util.js";

let carte = null;
let fond = null;
let nomFond = "sombre";
let coucheBornes = null;
let coucheTrajet = null;
let curseur = null;
let marqueurPosition = null;
let selection = null;
let decalageBas = 0;
const marqueurs = new Map();

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION_OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// Fond sombre = tuiles OpenStreetMap standard inversées par un filtre CSS
// (aucune clé requise, contrairement aux fonds sombres CARTO/Stadia).
const FONDS = {
  sombre: () => L.tileLayer(OSM, { maxZoom: 19, attribution: ATTRIBUTION_OSM, className: "ev-tuiles-sombres" }),
  plan: () => L.tileLayer(OSM, { maxZoom: 19, attribution: ATTRIBUTION_OSM }),
  satellite: () =>
    L.layerGroup([
      L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, attribution: "Imagerie © Esri" }),
      L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19 }),
      L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19 }),
    ]),
};
export const ORDRE_FONDS = ["sombre", "plan", "satellite"];
export const ICONES_FONDS = { sombre: "🌙", plan: "🗺️", satellite: "🛰️" };

export function initCarte(idElement, { fondInitial = "sombre", onDeplacement } = {}) {
  carte = L.map(idElement, { zoomControl: false, attributionControl: true, zoomSnap: 0.5 }).setView([46.6, 2.4], 6);
  carte.attributionControl.setPrefix(false);
  choisirFond(fondInitial);
  coucheBornes = L.layerGroup().addTo(carte);
  coucheTrajet = L.layerGroup().addTo(carte);
  carte.on("moveend", () => onDeplacement?.());
  return carte;
}

export function choisirFond(nom) {
  if (!FONDS[nom]) nom = "sombre";
  if (fond) carte.removeLayer(fond);
  fond = FONDS[nom]();
  fond.addTo(carte);
  if (fond.bringToBack) fond.bringToBack();
  nomFond = nom;
  return nom;
}

export function fondSuivant() {
  return choisirFond(ORDRE_FONDS[(ORDRE_FONDS.indexOf(nomFond) + 1) % ORDRE_FONDS.length]);
}

export function definirDecalageBas(px) {
  decalageBas = Math.max(0, px);
}

// Centre de la partie visible (au-dessus du panneau)
export function centreVisible() {
  const taille = carte.getSize();
  const p = carte.containerPointToLatLng([taille.x / 2, Math.max(1, (taille.y - decalageBas) / 2)]);
  return { lat: p.lat, lon: p.lng };
}

export function rayonVisibleKm() {
  const taille = carte.getSize();
  const c = carte.containerPointToLatLng([taille.x / 2, Math.max(1, (taille.y - decalageBas) / 2)]);
  const coin = carte.containerPointToLatLng([taille.x, 0]);
  return c.distanceTo(coin) / 1000;
}

export function zoomActuel() {
  return carte.getZoom();
}

export function centrer(lat, lon, zoom) {
  const z = zoom ?? carte.getZoom();
  const point = carte.project([lat, lon], z).add([0, decalageBas / 2]);
  carte.setView(carte.unproject(point, z), z, { animate: true });
}

// ── Bornes ──────────────────────────────────────────────────────────────────

export function classePuissance(kw) {
  return kw >= 150 ? "ultra" : kw >= 50 ? "rapide" : kw >= 22 ? "acc" : "lent";
}

export function puissanceBorne(b) {
  return Math.round(Math.max(b.puissance_max_kw || 0, b.officiel?.puissance_max_kw || 0));
}

function cbConfirmee(b) {
  const cb = b.officiel && !b.officiel.indisponible ? b.officiel.paiement_cb : null;
  return cb === "oui" || cb === "partiel";
}

function iconeBorne(b) {
  const kw = puissanceBorne(b);
  return L.divIcon({
    className: "",
    iconSize: [36, 46],
    iconAnchor: [18, 44],
    tooltipAnchor: [0, -40],
    html: `<div class="ev-pin ${classePuissance(kw)}${b === selection ? " selection" : ""}"><span>${kw || "?"}</span>${cbConfirmee(b) ? '<b class="ev-pin-cb">CB</b>' : ""}</div>`,
  });
}

export function afficherBornes(bornes, onClic) {
  coucheBornes.clearLayers();
  marqueurs.clear();
  for (const b of bornes) {
    const m = L.marker([b.lat, b.lon], { icon: iconeBorne(b), zIndexOffset: puissanceBorne(b) * 2 + (b === selection ? 10000 : 0) });
    m.on("click", () => onClic(b));
    m.addTo(coucheBornes);
    marqueurs.set(b, m);
  }
}

export function rafraichirBorne(b) {
  marqueurs.get(b)?.setIcon(iconeBorne(b));
}

export function selectionnerBorne(b) {
  const ancienne = selection;
  selection = b;
  if (ancienne) rafraichirBorne(ancienne);
  if (b) {
    rafraichirBorne(b);
    marqueurs.get(b)?.setZIndexOffset(10000);
  }
}

export function montrerBornes(visible) {
  if (visible && !carte.hasLayer(coucheBornes)) carte.addLayer(coucheBornes);
  if (!visible && carte.hasLayer(coucheBornes)) carte.removeLayer(coucheBornes);
}

// ── Position de l'utilisateur ───────────────────────────────────────────────

export function afficherPosition(lat, lon) {
  const icone = L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="ev-position"></div>' });
  if (marqueurPosition) marqueurPosition.setLatLng([lat, lon]);
  else marqueurPosition = L.marker([lat, lon], { icon: icone, interactive: false, zIndexOffset: 20000 }).addTo(carte);
}

// ── Itinéraire ──────────────────────────────────────────────────────────────

function pastille(taille, couleur, contenu = "") {
  return L.divIcon({
    className: "",
    iconSize: [taille, taille],
    iconAnchor: [taille / 2, taille / 2],
    html: `<div class="ev-point-trajet" style="width:${taille}px;height:${taille}px;background:${couleur};box-shadow:0 0 12px ${couleur};">${contenu}</div>`,
  });
}

function ajouterArrets(arrets, icone, prefixe, onClicArret) {
  (arrets || []).forEach((arret, i) => {
    if (arret.lat === undefined || arret.lon === undefined) return;
    L.marker([arret.lat, arret.lon], { icon: icone, zIndexOffset: 5000 })
      .bindTooltip(`${escapeHtml(prefixe(i))} : ${escapeHtml(arret.nom_borne || "Borne")}`)
      .on("click", () => onClicArret(arret))
      .addTo(coucheTrajet);
  });
}

export function afficherTrajet(data, onClicArret) {
  coucheTrajet.clearLayers();
  placerCurseur(undefined, undefined);
  if (!data?.coords?.length) return;

  const aller = L.polyline(data.coords.map(([lon, lat]) => [lat, lon]), { color: "#22e5a0", weight: 6, opacity: 0.9 }).addTo(coucheTrajet);
  L.polyline(data.coords.map(([lon, lat]) => [lat, lon]), { color: "#04221a", weight: 10, opacity: 0.35 }).addTo(coucheTrajet).bringToBack();
  let limites = aller.getBounds();

  const retour = data.retour;
  if (retour?.ok && retour.coords?.length) {
    const r = L.polyline(retour.coords.map(([lon, lat]) => [lat, lon]), { color: "#ffb400", weight: 4, opacity: 0.8, dashArray: "8,8" }).addTo(coucheTrajet);
    limites = limites.extend(r.getBounds());
    ajouterArrets(retour.arrets, pastille(24, "rgba(255,180,0,.95)", "🔋"), () => "Retour", onClicArret);
  }

  if (data.from_lat !== undefined) {
    L.marker([data.from_lat, data.from_lon], { icon: pastille(18, "#22e5a0"), zIndexOffset: 6000 }).bindTooltip(escapeHtml(data.from_name || "Départ")).addTo(coucheTrajet);
  }
  if (data.to_lat !== undefined) {
    L.marker([data.to_lat, data.to_lon], { icon: pastille(22, "#ff6b35", "🏁"), zIndexOffset: 6000 }).bindTooltip(escapeHtml(data.to_name || "Arrivée")).addTo(coucheTrajet);
  }
  ajouterArrets(data.arrets, pastille(30, "rgba(79,224,255,.95)", "🔋"), (i) => `Arrêt ${i + 1}`, onClicArret);

  carte.fitBounds(limites, { paddingTopLeft: [30, 130], paddingBottomRight: [30, decalageBas + 30] });
}

export function effacerTrajet() {
  coucheTrajet.clearLayers();
  placerCurseur(undefined, undefined);
}

export function placerCurseur(lat, lon, label) {
  if (!carte) return;
  if (curseur) {
    carte.removeLayer(curseur);
    curseur = null;
  }
  if (lat === undefined || lon === undefined) return;
  curseur = L.marker([lat, lon], { icon: pastille(22, "rgba(0,229,255,.95)"), zIndexOffset: 7000 })
    .bindTooltip(escapeHtml(label || "Position estimée"), { permanent: true, direction: "top", offset: [0, -12] })
    .addTo(carte);
}
