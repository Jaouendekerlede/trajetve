// Calcul d'itinéraire réel via l'API Routing de TomTom (clé gratuite) --
// porté depuis jarvis_tomtom_runtime.calculer_itineraire_tomtom, avec en
// plus : limitations de vitesse et zones urbaines (calcul détaillé),
// étapes intermédiaires (bornes de recharge), instructions de guidage en
// français (navigation), itinéraires alternatifs et suivi d'un tracé imposé.

import { haversineKm } from "./geo.js";

const SECTIONS_BASE = ["motorway", "tollRoad", "tunnel", "traffic"];
const SECTIONS_VITESSE = ["speedLimit", "urban"];
// Mesuré sur Paris -> Lyon : un point tous les ~450 m reconstruit
// exactement la route, un tous les ~1,8 km la fait dévier.
const ECART_POINTS_SUPPORT_KM = 0.25;

function allegerTrace(coords) {
  const garde = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const [lonA, latA] = garde[garde.length - 1];
    const [lon, lat] = coords[i];
    if (haversineKm(latA, lonA, lat, lon) >= ECART_POINTS_SUPPORT_KM) garde.push(coords[i]);
  }
  if (coords.length > 1) garde.push(coords[coords.length - 1]);
  return garde.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
}

async function requete(apiKey, points, options, sections, pointsSupport) {
  const chemin = points.map((p) => `${p.lat},${p.lon}`).join(":");
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${chemin}/json`;
  const params = new URLSearchParams({
    key: apiKey,
    routeRepresentation: "polyline",
    travelMode: "car",
    traffic: "true",
  });
  for (const s of sections) params.append("sectionType", s);
  if (options.departAt) params.set("departAt", options.departAt);
  if (options.instructions) {
    params.set("instructionsType", "text");
    params.set("language", "fr-FR");
  }
  if (options.maxAlternatives) params.set("maxAlternatives", String(options.maxAlternatives));
  // Direction actuelle de la voiture : évite un demi-tour absurde au recalcul.
  if (Number.isFinite(options.cap)) params.set("vehicleHeading", String(Math.round(((options.cap % 360) + 360) % 360)));

  if (options.eviterPeages) params.append("avoid", "tollRoads");
  if (options.eviterFerries) params.append("avoid", "ferries");
  if (options.eviterZonesFaiblesEmissions) params.append("avoid", "lowEmissionZones");
  if (options.eviterRoutesNonRevetues) params.append("avoid", "unpavedRoads");

  if (!pointsSupport) return fetch(`${url}?${params.toString()}`);
  return fetch(`${url}?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ supportingPoints: pointsSupport }),
  });
}

function lireRoute(route) {
  return {
    coords: route.legs.flatMap((leg) => leg.points.map((p) => [p.longitude, p.latitude])),
    summary: route.summary,
    sections: route.sections || [],
    guidance: route.guidance || null,
    legs: route.legs.map((leg) => ({ summary: leg.summary, nbPoints: leg.points.length })),
  };
}

// options.traceImposee ([lon, lat][]) : TomTom reconstruit cette route au
// lieu de choisir la plus rapide. Incompatible avec des étapes (refus de
// l'API), donc ignorée s'il y en a.
export async function calculerItineraireTomTom(apiKey, lat1, lon1, lat2, lon2, options = {}) {
  if (!apiKey) {
    return { erreur: "cle_manquante" };
  }
  const etapes = options.etapes || [];
  const points = [{ lat: lat1, lon: lon1 }, ...etapes, { lat: lat2, lon: lon2 }];
  const support = !etapes.length && options.traceImposee?.length >= 2 ? allegerTrace(options.traceImposee) : null;
  try {
    // Filets de sécurité : sans les sections de vitesse (requête d'origine
    // de JARVIS), puis sans le tracé imposé, plutôt que d'échouer.
    const essais = [
      [[...SECTIONS_BASE, ...SECTIONS_VITESSE], support],
      [SECTIONS_BASE, support],
    ];
    if (support) essais.push([[...SECTIONS_BASE, ...SECTIONS_VITESSE], null], [SECTIONS_BASE, null]);
    let resp;
    let traceSuivie = false;
    for (const [sections, pts] of essais) {
      resp = await requete(apiKey, points, options, sections, pts);
      traceSuivie = !!pts;
      if (resp.status !== 400) break;
    }
    if (!resp.ok) {
      console.warn(`[TOMTOM] Erreur HTTP ${resp.status}`);
      return { erreur: `http_${resp.status}` };
    }
    const data = await resp.json();
    const routes = (data.routes || []).map(lireRoute);
    if (!routes.length) return { erreur: "aucun_itineraire" };
    if (support && !traceSuivie) console.warn("[TOMTOM] Tracé imposé refusé, itinéraire le plus rapide utilisé");
    return { ...routes[0], alternatives: routes.slice(1), traceSuivie, erreur: null };
  } catch (e) {
    console.warn("[TOMTOM] Erreur calcul itinéraire", e);
    return { erreur: "reseau" };
  }
}
