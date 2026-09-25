// Algorithme de planification de trajet électrique -- porté tel quel
// depuis jarvis_ev_charge_runtime.calculer_trajet_electrique() et ses
// fonctions de score/confiance associées.

import {
  MULTIPLICATEURS_SAISON,
  FACTEUR_RALENTISSEMENT_DC,
  SEUIL_PUISSANCE_DC_KW,
  MARGE_SECURITE_PCT_DEFAUT,
  CIBLE_RECHARGE_PCT_DEFAUT,
  RESERVE_DERNIER_ARRET_PCT,
  MAX_ARRETS,
  PRIX_KWH_ESTIME_DEFAUT_EUR,
  MULTIPLICATEUR_CHARGE_LOURDE,
  MODES_TRAJET,
  PUISSANCE_LENTE_KW,
} from "./config.js";
import { pointADistanceSurTrace } from "./geo.js";
import { rechercherBornesProches, borneCompatible } from "./ocm.js";

export function consommationEffectiveKwh100km(profil) {
  const multiplicateur = MULTIPLICATEURS_SAISON[profil.saison] ?? 1.0;
  return profil.consommation_kwh_100km * multiplicateur;
}

export function typesDeCharge(profil) {
  return {
    lente: { label: "Lente (prise domestique)", puissance_kw: PUISSANCE_LENTE_KW },
    normale: { label: "Normale (borne AC)", puissance_kw: profil.puissance_ac_kw },
    rapide: { label: "Rapide (borne DC)", puissance_kw: profil.puissance_dc_kw },
  };
}

export function formaterMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

export function exporterTrajetTexte(r) {
  const lignes = [
    `Trajet électrique : ${r.from_name} -> ${r.to_name}`,
    "=".repeat(60),
    `Distance : ${r.distance_km} km`,
    `Durée de route : ${r.duree_text}`,
    `Arrêt(s) de recharge : ${r.nb_arrets ?? 0}`,
  ];
  if (r.duree_totale_min != null) lignes.push(`Temps total (route + charge) : ${formaterMinutes(r.duree_totale_min)}`);
  lignes.push(`Batterie à l'arrivée : ${r.pct_batterie_arrivee}%`);
  if (r.confiance) lignes.push(`Indice de confiance : ${r.confiance.score}/100`);
  lignes.push("");
  const arrets = r.arrets || [];
  if (arrets.length) {
    lignes.push("Arrêts détaillés :", "-".repeat(60));
    for (const a of arrets) {
      lignes.push(`${a.numero}. ${a.nom_borne} (km ${a.km_depuis_depart})`);
      lignes.push(`   ${a.adresse || ""}`);
      lignes.push(`   +${a.kwh_ajoutes} kWh, ${a.temps_charge_min} min, ${a.pct_arrivee_borne}% -> ${a.pct_depart_borne}%`);
      if (a.cout_estime_eur != null) lignes.push(`   Coût estimé : ${a.cout_estime_eur} €${a.prix_est_estimation ? " (estimation)" : ""}`);
      lignes.push(`   https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lon}`);
      lignes.push("");
    }
  }
  return lignes.join("\n");
}

export function exporterScenariosTexte(depart, destination, scenarios) {
  const lignes = [`Comparaison de scénarios : ${depart} -> ${destination}`, "=".repeat(60), ""];
  for (const [mode, r] of Object.entries(scenarios)) {
    lignes.push(`[${mode.toUpperCase()}]`);
    if (!r.ok) {
      lignes.push(`  Erreur : ${r.erreur}`);
    } else {
      lignes.push(`  Temps total : ${formaterMinutes(r.duree_totale_min ?? 0)}`);
      lignes.push(`  Coût estimé : ${r.cout_total_eur} €`);
      lignes.push(`  Arrêts : ${r.nb_arrets}`);
      lignes.push(`  Batterie à l'arrivée : ${r.pct_batterie_arrivee}%`);
      lignes.push(`  Confiance : ${r.confiance?.score ?? "?"}/100`);
    }
    lignes.push("");
  }
  return lignes.join("\n");
}

export function calculerTempsCharge(kwhAAjouter, puissanceKw) {
  if (puissanceKw <= 0 || kwhAAjouter <= 0) return 0;
  let minutes = (kwhAAjouter / puissanceKw) * 60;
  if (puissanceKw >= SEUIL_PUISSANCE_DC_KW) minutes *= FACTEUR_RALENTISSEMENT_DC;
  return minutes;
}

export function comparerCoutDomicilePublic(kwhACharger, profil, prixPublicEurKwh) {
  const arrondi2 = (x) => Math.round(x * 100) / 100;
  const prixDomicile = profil.prix_domicile_eur_kwh ?? 0.2;
  const coutDomicile = arrondi2(kwhACharger * prixDomicile);
  const coutPublic = arrondi2(kwhACharger * prixPublicEurKwh);
  return {
    kwh: Math.round(kwhACharger * 10) / 10,
    prix_domicile_eur_kwh: prixDomicile,
    prix_hc_eur_kwh: profil.prix_hc_eur_kwh,
    prix_hp_eur_kwh: profil.prix_hp_eur_kwh,
    part_hc_pct: profil.part_hc_pct,
    prix_public_eur_kwh: prixPublicEurKwh,
    cout_domicile_eur: coutDomicile,
    cout_hc_eur: profil.prix_hc_eur_kwh != null ? arrondi2(kwhACharger * profil.prix_hc_eur_kwh) : null,
    cout_hp_eur: profil.prix_hp_eur_kwh != null ? arrondi2(kwhACharger * profil.prix_hp_eur_kwh) : null,
    cout_public_eur: coutPublic,
    economie_eur: arrondi2(coutPublic - coutDomicile),
  };
}

function calculerScoreBorne(borne, profil, mode, preferCb = false) {
  const poids = MODES_TRAJET[mode] || MODES_TRAJET.confort;
  const details = [];
  let score = 50;

  const distance = borne.distance_km || 0;
  const pointsDistance = Math.max(-10, 15 - Math.round(distance * 2));
  score += pointsDistance;
  details.push({ label: `Détour/distance (${distance} km)`, points: pointsDistance });

  const puissance = borne.puissance_max_kw || 0;
  const ratioPuissance = profil.puissance_dc_kw ? Math.min(1.5, puissance / profil.puissance_dc_kw) : 0;
  const pointsPuissance = Math.round(ratioPuissance * 20 * poids.poids_puissance);
  score += pointsPuissance;
  details.push({ label: `Puissance (${puissance} kW)`, points: pointsPuissance });

  const nbPoints = borne.nombre_points || 1;
  const pointsNb = Math.min(10, nbPoints * 2);
  score += pointsNb;
  details.push({ label: `Nombre de points (${nbPoints})`, points: pointsNb });

  const statutOk = (borne.statut || "").toLowerCase().includes("operational");
  const pointsStatut = statutOk ? 15 : -20;
  score += pointsStatut;
  details.push({ label: `Statut déclaré (${borne.statut})`, points: pointsStatut });

  if (!borne.prix_est_estimation) {
    const pointsPrix = Math.round(5 * poids.poids_cout);
    score += pointsPrix;
    details.push({ label: "Tarif réel communiqué (pas une estimation)", points: pointsPrix });
  } else if (poids.poids_cout > 1.2) {
    score -= 3;
    details.push({ label: "Tarif non communiqué (estimation incertaine)", points: -3 });
  }

  if (borne.fraicheur?.niveau === "ancien") {
    score -= 5;
    details.push({ label: "Information ancienne sur cette borne", points: -5 });
  }

  if (preferCb) {
    const cb = borne.officiel?.paiement_cb;
    if (cb === "oui") {
      score += 15;
      details.push({ label: "Carte bancaire acceptée (déclaration officielle)", points: 15 });
    } else if (cb === "partiel") {
      score += 5;
      details.push({ label: "Carte bancaire sur une partie des points (déclaration officielle)", points: 5 });
    } else if (cb === "non") {
      score -= 15;
      details.push({ label: "Carte bancaire non acceptée (déclaration officielle)", points: -15 });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, details };
}

function calculerIndiceConfiance(resultat) {
  const details = [];
  let score = 60;

  const pctArrivee = resultat.pct_batterie_arrivee ?? 0;
  let pts = pctArrivee >= 30 ? 15 : pctArrivee >= 15 ? 5 : -15;
  score += pts;
  details.push({ label: `Marge de batterie à l'arrivée (${pctArrivee}%)`, points: pts });

  const arrets = resultat.arrets || [];
  if (!arrets.length) {
    score += 20;
    details.push({ label: "Trajet direct, aucune recharge nécessaire", points: 20 });
  } else {
    for (const a of arrets) {
      const niveau = a.fraicheur?.niveau;
      pts = niveau === "recent" ? 5 : niveau === "ancien" ? -8 : -3;
      score += pts;
      details.push({ label: `Fraîcheur des données (${a.nom_borne})`, points: pts });
      if (a.alternatives?.length) {
        score += 5;
        details.push({ label: `Plan B disponible pour ${a.nom_borne}`, points: 5 });
      } else {
        score -= 10;
        details.push({ label: `Aucune alternative trouvée pour ${a.nom_borne}`, points: -10 });
      }
      if (a.prix_est_estimation) {
        score -= 2;
        details.push({ label: `Tarif non confirmé (${a.nom_borne})`, points: -2 });
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, details };
}

// Algorithme glouton : roule jusqu'à la marge de sécurité, cherche la
// meilleure borne réelle à proximité, recharge jusqu'à la cible,
// recommence -- même algorithme que JARVIS. `options.energie` (voir
// energie.js) donne l'énergie consommée le long du tracé : avec une
// consommation constante, on retrouve exactement les calculs de JARVIS ;
// avec le calcul détaillé, vitesse, relief et météo sont pris en compte.
export async function calculerTrajetElectrique(ocmApiKey, distanceKm, coords, chargeActuellePct, profil, options = {}) {
  const margeSecuritePct = options.margeSecuritePct ?? MARGE_SECURITE_PCT_DEFAUT;
  const cibleRechargePct = options.cibleRechargePct ?? CIBLE_RECHARGE_PCT_DEFAUT;
  const puissanceMinKw = options.puissanceMinKw ?? 0;
  const seuilCoutEur = options.seuilCoutEur ?? null;
  const mode = options.mode ?? "confort";
  const chargeLourde = options.chargeLourde ?? false;
  const correctionMeteoMultiplicateur = options.correctionMeteoMultiplicateur ?? null;

  let energie = options.energie;
  if (!energie) {
    let consommation = correctionMeteoMultiplicateur
      ? correctionMeteoMultiplicateur * profil.consommation_kwh_100km
      : consommationEffectiveKwh100km(profil);
    if (chargeLourde) consommation *= MULTIPLICATEUR_CHARGE_LOURDE;
    energie = {
      energieA: (d) => (d * consommation) / 100,
      distanceMax: (d0, budget) => (budget <= 0 ? d0 : d0 + (budget / consommation) * 100),
    };
  }

  const capacite = profil.capacite_kwh;
  const margeKwh = (capacite * margeSecuritePct) / 100;
  const energieTotaleNecessaireKwh = energie.energieA(distanceKm);
  const consoMoyenne = Math.max(0.1, (energieTotaleNecessaireKwh / Math.max(distanceKm, 0.1)) * 100);
  const pctConsomme = (d0, d1) => ((energie.energieA(d1) - energie.energieA(d0)) / capacite) * 100;
  const atteignable = (d0, pct) => energie.distanceMax(d0, (capacite * pct) / 100 - margeKwh);

  const base = {
    autonomie_totale_km: Math.round((capacite / consoMoyenne) * 100),
    energie_totale_necessaire_kwh: Math.round(energieTotaleNecessaireKwh * 10) / 10,
  };

  if (atteignable(0, chargeActuellePct) >= distanceKm) {
    const pctArrivee = chargeActuellePct - pctConsomme(0, distanceKm);
    const resultatDirect = {
      ok: true,
      arrets: [],
      nb_arrets: 0,
      pct_batterie_arrivee: Math.round(pctArrivee * 10) / 10,
      temps_charge_total_min: 0,
      cout_total_eur: 0,
      depasse_seuil_cout: false,
      comparaison_domicile: comparerCoutDomicilePublic(energieTotaleNecessaireKwh, profil, PRIX_KWH_ESTIME_DEFAUT_EUR),
      ...base,
    };
    resultatDirect.confiance = calculerIndiceConfiance(resultatDirect);
    return resultatDirect;
  }

  const arrets = [];
  let distanceParcourue = 0;
  let chargePct = chargeActuellePct;

  while (true) {
    const limite = atteignable(distanceParcourue, chargePct);
    if (limite >= distanceKm) break;
    const distanceMaxAvantRecharge = limite - distanceParcourue;

    if (distanceMaxAvantRecharge <= 0) {
      return { ok: false, erreur: "Autonomie insuffisante pour rejoindre une borne en sécurité à cette étape.", ...base };
    }
    if (arrets.length >= MAX_ARRETS) {
      return { ok: false, erreur: "Trajet trop long pour ce planificateur (plus de 6 arrêts nécessaires).", ...base };
    }

    const pointRechargeKm = distanceParcourue + distanceMaxAvantRecharge;
    const point = pointADistanceSurTrace(coords, pointRechargeKm);
    if (!point) {
      return { ok: false, erreur: "Impossible de localiser un point de recharge sur le tracé.", ...base };
    }

    let recherche = await rechercherBornesProches(ocmApiKey, point.lat, point.lon);
    // Bornes rapides de la base officielle (absentes d'Open Charge Map, ou
    // si Open Charge Map est indisponible).
    if (options.bornesSupplementaires) {
      const extra = await options.bornesSupplementaires(point.lat, point.lon);
      if (extra.length) {
        const fusion = options.fusionner(recherche.ok ? recherche.bornes : [], extra).slice(0, 15);
        recherche = { ok: true, bornes: fusion, erreur: null };
      }
    }
    if (!recherche.ok) {
      if (recherche.erreur === "cle_manquante") {
        return { ok: false, erreur: "La recherche de bornes nécessite une clé Open Charge Map (gratuite sur openchargemap.org).", ...base };
      }
      return { ok: false, erreur: `Service de recherche de bornes indisponible (${recherche.erreur}).`, ...base };
    }
    if (!recherche.bornes.length) {
      return { ok: false, erreur: `Aucune borne de recharge trouvée à proximité du km ${Math.round(pointRechargeKm)}, même en élargissant la recherche.`, ...base };
    }

    const connecteursAcceptes = profil.connecteurs_acceptes?.length ? profil.connecteurs_acceptes : ["CCS", "Type 2"];
    let candidates = recherche.bornes.filter((b) => borneCompatible(b, connecteursAcceptes));
    if (puissanceMinKw > 0) {
      candidates = candidates.filter((b) => (b.puissance_max_kw || 0) >= puissanceMinKw);
    }
    if (!candidates.length) {
      return { ok: false, erreur: `Aucune borne compatible (connecteur/puissance) trouvée à proximité du km ${Math.round(pointRechargeKm)}.`, ...base };
    }

    if (options.enrichirBornes) await options.enrichirBornes(candidates);
    for (const b of candidates) b._score_info = calculerScoreBorne(b, profil, mode, !!options.preferCb);
    candidates.sort((a, b) => b._score_info.score - a._score_info.score);

    const borne = candidates[0];
    const alternatives = candidates.slice(1, 4).map((b) => ({
      nom: b.nom,
      adresse: b.adresse,
      lat: b.lat,
      lon: b.lon,
      distance_km: b.distance_km,
      puissance_max_kw: b.puissance_max_kw,
      operateur: b.operateur,
      statut: b.statut,
      connecteurs: b.connecteurs,
      type_acces: b.type_acces,
      cout_texte: b.cout_texte,
      prix_kwh_eur: b.prix_kwh_eur,
      prix_est_estimation: b.prix_est_estimation,
      paiement_cb_probable: b.paiement_cb_probable,
      prix_source: b.prix_source,
      fraicheur: b.fraicheur,
      officiel: b.officiel,
      score: b._score_info.score,
    }));

    const chargeALaBornePct = Math.round(margeSecuritePct * 10) / 10;
    // Dernier arrêt (la cible suffit pour finir) : charger jusqu'à la cible
    // ferait arriver très chargé après une longue attente, souvent sur une
    // borne lente près de l'arrivée.
    const besoinFinPct = Math.ceil(margeSecuritePct + pctConsomme(pointRechargeKm, distanceKm) + RESERVE_DERNIER_ARRET_PCT);
    const departBornePct = atteignable(pointRechargeKm, cibleRechargePct) >= distanceKm ? Math.min(cibleRechargePct, Math.max(chargeALaBornePct + 1, besoinFinPct)) : cibleRechargePct;
    const kwhACharger = (profil.capacite_kwh * (departBornePct - chargeALaBornePct)) / 100;
    const puissanceKw = borne.puissance_max_kw ? Math.min(borne.puissance_max_kw, profil.puissance_dc_kw) : profil.puissance_dc_kw;
    const tempsChargeMin = calculerTempsCharge(kwhACharger, puissanceKw);
    const coutEstimeEur = Math.round(kwhACharger * borne.prix_kwh_eur * 100) / 100;

    arrets.push({
      numero: arrets.length + 1,
      km_depuis_depart: Math.round(pointRechargeKm * 10) / 10,
      nom_borne: borne.nom,
      adresse: borne.adresse,
      lat: borne.lat,
      lon: borne.lon,
      distance_borne_km: borne.distance_km,
      kwh_ajoutes: Math.round(kwhACharger * 10) / 10,
      puissance_kw: Math.round(puissanceKw),
      temps_charge_min: Math.round(tempsChargeMin),
      pct_arrivee_borne: chargeALaBornePct,
      pct_depart_borne: departBornePct,
      operateur: borne.operateur,
      statut: borne.statut,
      nombre_points: borne.nombre_points,
      connecteurs: borne.connecteurs,
      cout_estime_eur: coutEstimeEur,
      prix_kwh_eur: borne.prix_kwh_eur,
      prix_est_estimation: borne.prix_est_estimation,
      fraicheur: borne.fraicheur,
      puissance_max_kw: borne.puissance_max_kw,
      type_acces: borne.type_acces,
      cout_texte: borne.cout_texte,
      derniere_maj: borne.derniere_maj,
      paiement_cb_probable: borne.paiement_cb_probable,
      prix_source: borne.prix_source,
      officiel: borne.officiel,
      score: borne._score_info.score,
      score_details: borne._score_info.details,
      alternatives,
    });
    distanceParcourue = pointRechargeKm;
    chargePct = departBornePct;
  }

  const pctArrivee = chargePct - pctConsomme(distanceParcourue, distanceKm);

  const coutTotalEur = Math.round(arrets.reduce((s, a) => s + a.cout_estime_eur, 0) * 100) / 100;
  const prixPublicMoyen = arrets.length ? arrets.reduce((s, a) => s + a.prix_kwh_eur, 0) / arrets.length : PRIX_KWH_ESTIME_DEFAUT_EUR;

  const resultatFinal = {
    ok: true,
    arrets,
    nb_arrets: arrets.length,
    pct_batterie_arrivee: Math.round(pctArrivee * 10) / 10,
    temps_charge_total_min: Math.round(arrets.reduce((s, a) => s + a.temps_charge_min, 0)),
    cout_total_eur: coutTotalEur,
    depasse_seuil_cout: seuilCoutEur !== null && coutTotalEur > seuilCoutEur,
    comparaison_domicile: comparerCoutDomicilePublic(energieTotaleNecessaireKwh, profil, prixPublicMoyen),
    ...base,
  };
  resultatFinal.confiance = calculerIndiceConfiance(resultatFinal);
  return resultatFinal;
}
