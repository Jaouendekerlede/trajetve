// Calcul d'itinéraire réel via l'API Routing de TomTom (clé gratuite) --
// porté depuis jarvis_tomtom_runtime.calculer_itineraire_tomtom, avec en
// plus les limitations de vitesse et zones urbaines (profil de vitesse du
// calcul détaillé).

const SECTIONS_BASE = ["motorway", "tollRoad", "tunnel", "traffic"];
const SECTIONS_VITESSE = ["speedLimit", "urban"];

async function requete(apiKey, lat1, lon1, lat2, lon2, options, sections) {
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${lat1},${lon1}:${lat2},${lon2}/json`;
  const params = new URLSearchParams({
    key: apiKey,
    routeRepresentation: "polyline",
    travelMode: "car",
    traffic: "true",
  });
  for (const s of sections) params.append("sectionType", s);
  if (options.departAt) params.set("departAt", options.departAt);

  if (options.eviterPeages) params.append("avoid", "tollRoads");
  if (options.eviterFerries) params.append("avoid", "ferries");
  if (options.eviterZonesFaiblesEmissions) params.append("avoid", "lowEmissionZones");
  if (options.eviterRoutesNonRevetues) params.append("avoid", "unpavedRoads");

  return fetch(`${url}?${params.toString()}`);
}

export async function calculerItineraireTomTom(apiKey, lat1, lon1, lat2, lon2, options = {}) {
  if (!apiKey) {
    return { erreur: "cle_manquante" };
  }
  try {
    let resp = await requete(apiKey, lat1, lon1, lat2, lon2, options, [...SECTIONS_BASE, ...SECTIONS_VITESSE]);
    // Filet de sécurité : si TomTom refuse les sections de vitesse, on
    // retombe sur la requête d'origine de JARVIS plutôt que d'échouer.
    if (resp.status === 400) resp = await requete(apiKey, lat1, lon1, lat2, lon2, options, SECTIONS_BASE);
    if (!resp.ok) {
      console.warn(`[TOMTOM] Erreur HTTP ${resp.status}`);
      return { erreur: `http_${resp.status}` };
    }
    const data = await resp.json();
    const routes = data.routes || [];
    if (!routes.length) return { erreur: "aucun_itineraire" };

    const route = routes[0];
    const coords = route.legs.flatMap((leg) => leg.points.map((p) => [p.longitude, p.latitude]));
    return { coords, summary: route.summary, sections: route.sections || [], erreur: null };
  } catch (e) {
    console.warn("[TOMTOM] Erreur calcul itinéraire", e);
    return { erreur: "reseau" };
  }
}
