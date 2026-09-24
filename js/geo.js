// Géocodage (Nominatim/OpenStreetMap, gratuit, sans clé) + calcul de
// distance -- portés depuis jarvis_weather_runtime.geocode_lieu et
// jarvis_ev_charge_runtime.haversine_km.

export async function geocodeLieu(nomLieu) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(nomLieu)}&format=json&limit=1`;
  for (let tentative = 0; tentative < 2; tentative++) {
    try {
      const resp = await fetch(url, { headers: { "Accept-Language": "fr" } });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.length) {
          return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), nom: data[0].display_name || nomLieu };
        }
        return null;
      }
    } catch (e) {
      console.warn(`[GEO] Erreur géocodage "${nomLieu}" (tentative ${tentative + 1}/2)`, e);
    }
    if (tentative === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const MOTS_POSITION = ["ma position", "position actuelle", "ici", "gps"];
const MOTS_DOMICILE = ["chez moi", "maison", "domicile", "à la maison", "a la maison"];

function positionGps() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ erreur: "La localisation GPS n'est pas disponible sur cet appareil." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, nom: "Ma position" }),
      (err) =>
        resolve({
          erreur:
            err.code === err.PERMISSION_DENIED
              ? "Accès à la position refusé. Autorise la localisation pour cette appli dans Chrome."
              : "Position GPS introuvable pour le moment. Réessaie ou saisis une adresse.",
        }),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
    );
  });
}

// Même rôle que _resoudre_lieu_itineraire de JARVIS : "chez moi" et "ma
// position" sont des raccourcis, tout le reste passe par le géocodage.
export async function resoudreLieu(nomLieu, adresseDomicile) {
  const brut = (nomLieu || "").trim();
  const cle = brut.toLowerCase();
  if (!brut || MOTS_POSITION.includes(cle)) return positionGps();
  if (MOTS_DOMICILE.includes(cle)) {
    if (!adresseDomicile) {
      return { erreur: "Adresse du domicile non renseignée. Ajoute-la dans 🚗 Profil véhicule, ou utilise « Ma position »." };
    }
    const lieu = await geocodeLieu(adresseDomicile);
    return lieu ? { ...lieu, nom: `Chez moi (${lieu.nom})` } : { erreur: `Adresse du domicile introuvable : "${adresseDomicile}".` };
  }
  const lieu = await geocodeLieu(brut);
  return lieu || { erreur: `Lieu introuvable : "${brut}".` };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rayonTerreKm = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlambda / 2) ** 2;
  return rayonTerreKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// coords : liste de [lon, lat] (format TomTom). Trouve le point situé à
// `distanceCibleKm` du début du tracé, par interpolation linéaire entre
// les deux points qui l'encadrent.
export function pointADistanceSurTrace(coords, distanceCibleKm) {
  if (!coords || !coords.length || distanceCibleKm <= 0) {
    return coords && coords.length ? { lat: coords[0][1], lon: coords[0][0] } : null;
  }
  let cumulKm = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    const segmentKm = haversineKm(latA, lonA, latB, lonB);
    if (cumulKm + segmentKm >= distanceCibleKm) {
      if (segmentKm <= 0) return { lat: latA, lon: lonA };
      const ratio = (distanceCibleKm - cumulKm) / segmentKm;
      return { lat: latA + (latB - latA) * ratio, lon: lonA + (lonB - lonA) * ratio };
    }
    cumulKm += segmentKm;
  }
  const dernier = coords[coords.length - 1];
  return { lat: dernier[1], lon: dernier[0] };
}
