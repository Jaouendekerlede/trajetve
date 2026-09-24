// Carte Leaflet du trajet -- même rendu que la carte embarquée du panneau
// Trajet VE de JARVIS (vue satellite + routes, tracé vert, retour orange
// pointillé, pastilles 🔋 cliquables, curseur "où serai-je ?").

import { escapeHtml } from "./util.js";

let carte = null;
let coucheAller = null;
let coucheRetour = null;
let marqueurs = [];
let curseur = null;

function creerCarte() {
  if (carte) return carte;
  carte = L.map("ev-charge-map", { zoomControl: true });
  carte.attributionControl.setPrefix(false);

  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services";
  const satellite = L.layerGroup([
    L.tileLayer(`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, attribution: "Imagerie © Esri" }),
    L.tileLayer(`${esri}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19 }),
    L.tileLayer(`${esri}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19 }),
  ]);
  const plan = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  });
  satellite.addTo(carte);
  L.control.layers({ "🛰️ Satellite": satellite, "🗺️ Plan": plan }, null, { position: "topright" }).addTo(carte);
  return carte;
}

function pastille(taille, couleur, contenu = "") {
  return L.divIcon({
    className: "",
    iconSize: [taille, taille],
    iconAnchor: [taille / 2, taille / 2],
    html: `<div style="width:${taille}px;height:${taille}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(taille * 0.55)}px;background:${couleur};border-radius:50%;border:2px solid #fff;box-shadow:0 0 10px ${couleur};">${contenu}</div>`,
  });
}

function ajouterArrets(arrets, icone, prefixe, onClicArret) {
  (arrets || []).forEach((arret, i) => {
    if (arret.lat === undefined || arret.lon === undefined) return;
    const m = L.marker([arret.lat, arret.lon], { icon: icone }).bindTooltip(
      `${escapeHtml(prefixe(i))} : ${escapeHtml(arret.nom_borne || "Borne")} (touche pour le détail)`,
    );
    m.on("click", () => onClicArret(arret));
    m.addTo(carte);
    marqueurs.push(m);
  });
}

export function afficherTrajetSurCarte(data, onClicArret) {
  const el = document.getElementById("ev-charge-map");
  const vide = document.getElementById("ev-charge-map-empty");
  if (!data || !data.coords || !data.coords.length) {
    masquerCarte();
    return;
  }
  el.classList.add("visible");
  if (vide) vide.hidden = true;

  // Laisse le navigateur appliquer l'affichage avant que Leaflet mesure le conteneur.
  setTimeout(() => {
    creerCarte();
    carte.invalidateSize();

    if (coucheAller) carte.removeLayer(coucheAller);
    if (coucheRetour) carte.removeLayer(coucheRetour);
    coucheAller = coucheRetour = null;
    marqueurs.forEach((m) => carte.removeLayer(m));
    marqueurs = [];
    placerCurseur(undefined, undefined);

    coucheAller = L.polyline(data.coords.map(([lon, lat]) => [lat, lon]), { color: "#22e5a0", weight: 4, opacity: 0.85 }).addTo(carte);
    let limites = coucheAller.getBounds();

    const retour = data.retour;
    if (retour && retour.ok && retour.coords && retour.coords.length) {
      coucheRetour = L.polyline(retour.coords.map(([lon, lat]) => [lat, lon]), {
        color: "#ffb400",
        weight: 3,
        opacity: 0.75,
        dashArray: "6,6",
      }).addTo(carte);
      limites = limites.extend(coucheRetour.getBounds());
      ajouterArrets(retour.arrets, pastille(22, "rgba(255,180,0,.92)", "🔋"), () => "Retour", onClicArret);
    }

    carte.fitBounds(limites, { padding: [24, 24] });

    if (data.from_lat !== undefined) {
      marqueurs.push(L.marker([data.from_lat, data.from_lon], { icon: pastille(14, "#22e5a0") }).bindTooltip(escapeHtml(data.from_name || "Départ")).addTo(carte));
    }
    if (data.to_lat !== undefined) {
      marqueurs.push(L.marker([data.to_lat, data.to_lon], { icon: pastille(14, "#ff6b35") }).bindTooltip(escapeHtml(data.to_name || "Arrivée")).addTo(carte));
    }
    ajouterArrets(data.arrets, pastille(26, "rgba(34,229,160,.92)", "🔋"), (i) => `Arrêt ${i + 1}`, onClicArret);
  }, 50);
}

export function masquerCarte() {
  document.getElementById("ev-charge-map")?.classList.remove("visible");
  const vide = document.getElementById("ev-charge-map-empty");
  if (vide) vide.hidden = false;
}

export function placerCurseur(lat, lon, label) {
  if (!carte) return;
  if (curseur) {
    carte.removeLayer(curseur);
    curseur = null;
  }
  if (lat === undefined || lon === undefined) return;
  curseur = L.marker([lat, lon], { icon: pastille(20, "rgba(0,229,255,.9)") })
    .bindTooltip(escapeHtml(label || "Position estimée"))
    .addTo(carte);
  curseur.openTooltip();
}
