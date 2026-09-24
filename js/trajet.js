// Orchestration d'un calcul complet -- équivalent de
// _ev_planifier_trajet_interne et des handlers ev_* de main2.py (JARVIS),
// mais exécuté directement dans le téléphone, sans serveur.

import { getApiKeys, PALIERS_TEMPERATURE, MODES_TRAJET, MULTIPLICATEUR_CHARGE_LOURDE } from "./config.js";
import { obtenirProfilVehicule, enregistrerHistoriqueTrajet, lireReglages } from "./storage.js";
import { resoudreLieu, pointADistanceSurTrace } from "./geo.js";
import { calculerItineraireTomTom } from "./tomtom.js";
import { calculerTrajetElectrique, formaterMinutes, consommationEffectiveKwh100km } from "./planner.js";
import { construireProfilEnergie, fonctionsEnergie, fonctionsEnergieConstante } from "./energie.js";
import { enrichirBornes } from "./irve.js";
import { rechercherBornesProches, rechercherBornesZone, borneCompatible } from "./ocm.js";

const arrondi1 = (x) => Math.round(x * 10) / 10;

function messageOcm(erreur) {
  return erreur === "cle_manquante"
    ? "Clé Open Charge Map manquante ou invalide (🚗 Profil véhicule > Clés API)."
    : `Service de recherche de bornes indisponible (${erreur}).`;
}

function messageTomTom(erreur, fromName, toName) {
  if (erreur === "cle_manquante") return "Itinéraire routier indisponible : clé TomTom manquante (🚗 Profil véhicule > Clés API).";
  if (erreur === "http_403" || erreur === "http_401") return "Clé TomTom refusée : vérifie la clé et que l'« API de routage » est bien cochée sur developer.tomtom.com.";
  if (erreur === "reseau") return "Pas de connexion réseau : impossible de calculer l'itinéraire.";
  return `Aucun itinéraire routier trouvé entre "${fromName}" et "${toName}" (destination non joignable par la route, ou lieu mal identifié).`;
}

export async function obtenirCorrectionMeteo(lat, lon) {
  const indisponible = { ok: false, multiplicateur: 1.0, description: "Météo indisponible" };
  try {
    const params = new URLSearchParams({ latitude: lat, longitude: lon, current: "temperature_2m" });
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!resp.ok) return indisponible;
    const temp = (await resp.json())?.current?.temperature_2m;
    if (typeof temp !== "number") return indisponible;
    for (const [seuil, multiplicateur, description] of PALIERS_TEMPERATURE) {
      if (temp < seuil) return { ok: true, multiplicateur, temperature_c: temp, description };
    }
    return { ok: true, multiplicateur: 1.05, temperature_c: temp, description: "chaleur, climatisation" };
  } catch {
    return indisponible;
  }
}

async function calculerItineraire(depart, destination, opts) {
  const { tomtom } = getApiKeys();
  if (!tomtom) return { ok: false, erreur: messageTomTom("cle_manquante") };
  const domicile = lireReglages().adresse_domicile;

  // Séquentiel exprès : Nominatim demande au plus 1 requête/seconde.
  const a = await resoudreLieu(depart, domicile);
  if (a.erreur) return { ok: false, erreur: a.erreur };
  const b = await resoudreLieu(destination, domicile);
  if (b.erreur) return { ok: false, erreur: b.erreur };

  const departMs = departPrevuMs(opts);
  const it = await calculerItineraireTomTom(tomtom, a.lat, a.lon, b.lat, b.lon, {
    eviterPeages: opts.eviter_peages,
    eviterFerries: opts.eviter_ferries,
    eviterZonesFaiblesEmissions: opts.eviter_zones_faibles_emissions,
    eviterRoutesNonRevetues: opts.eviter_routes_non_revetues,
    // TomTom prévoit alors le trafic à cette heure-là
    departAt: departMs > Date.now() + 5 * 60000 ? new Date(departMs).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
  });
  if (it.erreur) return { ok: false, erreur: messageTomTom(it.erreur, a.nom, b.nom) };

  const dureeMin = Math.floor(it.summary.travelTimeInSeconds / 60);
  return {
    ok: true,
    _sections: it.sections,
    _summary: it.summary,
    depart_ms: departMs,
    from_name: a.nom,
    to_name: b.nom,
    from_lat: a.lat,
    from_lon: a.lon,
    to_lat: b.lat,
    to_lon: b.lon,
    distance_km: arrondi1(it.summary.lengthInMeters / 1000),
    duree_min: dureeMin,
    duree_text: formaterMinutes(dureeMin),
    coords: it.coords,
  };
}

function departPrevuMs(opts) {
  const ms = opts.depart_prevu ? new Date(opts.depart_prevu).getTime() : NaN;
  return Number.isFinite(ms) && ms > Date.now() ? ms : Date.now();
}

async function profilEnergiePour(itin, opts) {
  try {
    return await construireProfilEnergie(itin, obtenirProfilVehicule(), {
      ajuster_meteo: opts.ajuster_meteo,
      charge_lourde: opts.charge_lourde,
      depart_ms: itin.depart_ms,
    });
  } catch (e) {
    console.warn("[ENERGIE] Profil détaillé impossible, consommation constante utilisée", e);
    return null;
  }
}

// Batterie le long du trajet, avec la remontée à chaque arrêt -- sert à la
// courbe et à la frise "où serai-je ?".
function courbeBatterie(energie, kmPoints, chargeDepartPct, arrets, capacite) {
  const points = [];
  let refKm = 0;
  let refPct = chargeDepartPct;
  let a = 0;
  const pctA = (d) => refPct - ((energie.energieA(d) - energie.energieA(refKm)) / capacite) * 100;
  for (const km of kmPoints) {
    while (a < arrets.length && arrets[a].km_depuis_depart <= km) {
      const kmArret = arrets[a].km_depuis_depart;
      points.push({ km: kmArret, pct: pctA(kmArret) });
      refKm = kmArret;
      refPct = arrets[a].pct_depart_borne;
      points.push({ km: kmArret, pct: refPct });
      a++;
    }
    points.push({ km, pct: pctA(km) });
  }
  return points.map((p) => ({ km: arrondi1(p.km), pct: arrondi1(p.pct) }));
}

async function planifierSurItineraire(itin, chargePct, opts) {
  const profil = obtenirProfilVehicule();
  const profilEnergie = opts.profil_energie !== undefined ? opts.profil_energie : await profilEnergiePour(itin, opts);
  const detaille = opts.modele_detaille !== false && profilEnergie;

  // Sans calcul détaillé : exactement la logique JARVIS (consommation
  // constante, corrigée par la température au départ si demandé).
  let meteoInfo = null;
  let energie;
  if (detaille) {
    energie = fonctionsEnergie(profilEnergie.km, profilEnergie.ecum);
  } else {
    if (opts.ajuster_meteo) meteoInfo = profilEnergie?.meteo_depart ?? (await obtenirCorrectionMeteo(itin.from_lat, itin.from_lon));
    let conso = meteoInfo?.ok ? meteoInfo.multiplicateur * profil.consommation_kwh_100km : consommationEffectiveKwh100km(profil);
    if (opts.charge_lourde) conso *= MULTIPLICATEUR_CHARGE_LOURDE;
    energie = fonctionsEnergieConstante(conso);
  }

  const resultat = await calculerTrajetElectrique(getApiKeys().openChargeMap, itin.distance_km, itin.coords, chargePct, profil, {
    margeSecuritePct: opts.marge_pct,
    cibleRechargePct: opts.cible_pct,
    puissanceMinKw: opts.puissance_min_kw,
    seuilCoutEur: opts.seuil_cout_eur,
    mode: opts.mode,
    energie,
    enrichirBornes,
    preferCb: opts.preferer_cb,
  });
  if (meteoInfo) resultat.meteo_info = meteoInfo;

  const { _sections, _summary, ...itinPublic } = itin;
  const dureeTotaleMin = resultat.ok ? itin.duree_min + (resultat.temps_charge_total_min || 0) : null;
  const complet = { ...itinPublic, duree_totale_min: dureeTotaleMin, ...resultat, modele: detaille ? "detaille" : "constant" };

  if (profilEnergie) {
    const kmPoints = [0, ...profilEnergie.segments.map((s) => s.km_fin)];
    complet.profil_trajet = {
      segments: profilEnergie.segments,
      stats: detaille
        ? profilEnergie.stats
        : { ...profilEnergie.stats, conso_moyenne_kwh100: (energie.energieA(itin.distance_km) / itin.distance_km) * 100, energie_totale_kwh: energie.energieA(itin.distance_km) },
      relief_ok: profilEnergie.relief_ok,
      meteo_ok: profilEnergie.meteo_ok,
      // En mode constant, la courbe de conso affichée doit être celle utilisée pour le plan.
      conso_constante: detaille ? null : (energie.energieA(100)),
      batterie: resultat.ok ? courbeBatterie(energie, kmPoints, chargePct, resultat.arrets, profil.capacite_kwh) : null,
    };
  }
  return complet;
}

export async function planifierTrajet(depart, destination, opts, sauvegarder = true) {
  const itin = await calculerItineraire(depart, destination, opts);
  if (!itin.ok) return itin;
  const resultat = await planifierSurItineraire(itin, opts.charge_pct, opts);
  if (resultat.ok && sauvegarder) {
    enregistrerHistoriqueTrajet(depart, destination, resultat, {
      mode: opts.mode,
      marge_pct: opts.marge_pct,
      cible_pct: opts.cible_pct,
      charge_pct: opts.charge_pct,
      eviter_peages: opts.eviter_peages,
      puissance_min_kw: opts.puissance_min_kw,
    });
  }
  return resultat;
}

// Retour : on suppose une recharge jusqu'à l'objectif à destination avant
// de repartir (même hypothèse que JARVIS).
export async function planifierAllerRetour(depart, destination, opts) {
  const aller = await planifierTrajet(depart, destination, opts);
  const retour = await planifierTrajet(destination, depart, { ...opts, charge_pct: opts.cible_pct });
  return { aller, retour };
}

// Même trajet dans les 4 modes -- l'itinéraire est calculé une seule fois
// puis réutilisé, pour économiser les appels TomTom.
export async function comparerScenarios(depart, destination, opts) {
  const itin = await calculerItineraire(depart, destination, opts);
  if (!itin.ok) return { ok: false, erreur: itin.erreur };
  const profilEnergie = await profilEnergiePour(itin, opts);
  const scenarios = {};
  for (const [mode, poids] of Object.entries(MODES_TRAJET)) {
    scenarios[mode] = await planifierSurItineraire(itin, opts.charge_pct, {
      ...opts,
      mode,
      marge_pct: poids.marge_pct,
      cible_pct: poids.cible_pct,
      profil_energie: profilEnergie,
    });
  }
  return { ok: true, depart, destination, scenarios };
}

// Curseur "Où serai-je ?" : l'interface convertit déjà le temps de conduite
// en distance (profil de vitesse du trajet).
export async function bornesADistance(trajet, distanceKm) {
  const distanceCibleKm = Math.max(0, Math.min(trajet.distance_km, distanceKm));
  const point = pointADistanceSurTrace(trajet.coords, distanceCibleKm);
  if (!point) return { ok: false, erreur: "Point introuvable sur le trajet." };
  const recherche = await rechercherBornesProches(getApiKeys().openChargeMap, point.lat, point.lon, 20, 8);
  if (!recherche.ok) return { ok: false, erreur: messageOcm(recherche.erreur) };
  return { ok: true, distance_cible_km: arrondi1(distanceCibleKm), lat: point.lat, lon: point.lon, bornes: recherche.bornes };
}

export async function rechercherBornesAutour(lieu, filtres = {}) {
  const l = await resoudreLieu(lieu, lireReglages().adresse_domicile);
  if (l.erreur) return { ok: false, erreur: l.erreur };
  const recherche = await rechercherBornesZone(getApiKeys().openChargeMap, l.lat, l.lon, {
    rayonKm: filtres.rayon_km ?? 15,
    filtreOperateur: filtres.operateur || "",
    filtreTypeAcces: filtres.type_acces || "",
    maxResultats: 40,
  });
  if (!recherche.ok) return { ok: false, erreur: messageOcm(recherche.erreur) };
  let bornes = recherche.bornes;
  if (filtres.carte_bancaire_uniquement) {
    // Déclaration officielle d'abord ; à défaut, règle légale des ≥50 kW.
    await enrichirBornes(bornes);
    bornes = bornes.filter((b) => (b.officiel && !b.officiel.indisponible ? b.officiel.paiement_cb !== "non" : b.paiement_cb_probable));
  }
  return { ok: true, lieu: l.nom, lat: l.lat, lon: l.lon, bornes };
}

// Mode urgence : position GPS d'abord (on est sur la route), sinon le lieu
// de départ saisi. Seules les bornes compatibles avec le véhicule sont
// proposées -- recommander une prise inutilisable en urgence serait pire
// que rien.
export async function bornesUrgence(lieuDeSecours) {
  let recherche = await rechercherBornesAutour("ma position", { rayon_km: 30 });
  if (!recherche.ok && lieuDeSecours) recherche = await rechercherBornesAutour(lieuDeSecours, { rayon_km: 30 });
  if (!recherche.ok) return recherche;
  const connecteurs = obtenirProfilVehicule().connecteurs_acceptes;
  const bornes = recherche.bornes.filter((b) => borneCompatible(b, connecteurs)).slice(0, 3);
  await enrichirBornes(bornes);
  return { ...recherche, bornes };
}
