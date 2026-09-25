// Configuration -- clés API et constantes du modèle de planification,
// portées telles quelles depuis jarvis_ev_charge_runtime.py (JARVIS).

export const STORAGE_KEYS = {
  apiKeys: "trajetve_api_keys",
  profil: "trajetve_profil",
  historique: "trajetve_historique",
  favoris: "trajetve_favoris",
  bornesFavorites: "trajetve_bornes_favorites",
  bornesNotes: "trajetve_bornes_notes",
  prefs: "trajetve_prefs",
  reglages: "trajetve_reglages",
  journal: "trajetve_journal",
  zonesEvitees: "trajetve_zones_evitees",
};

export function getApiKeys() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.apiKeys)) || { tomtom: "", openChargeMap: "" };
  } catch {
    return { tomtom: "", openChargeMap: "" };
  }
}

export function setApiKeys(keys) {
  localStorage.setItem(STORAGE_KEYS.apiKeys, JSON.stringify(keys));
}

// Hyundai Kona Electric 64,8 kWh -- même profil par défaut que JARVIS.
export const PROFIL_PAR_DEFAUT = {
  nom: "HYUNDAI - KONA - INTUITIVE - 65 kWh",
  capacite_kwh: 64.8,
  consommation_kwh_100km: 13.2,
  puissance_ac_kw: 11.0,
  // Puissance maximale réellement atteinte (fiche Hyundai : 77 kW) ; elle
  // sert de base à la courbe de charge rapide.
  puissance_dc_kw: 77.0,
  // Borne murale « 7 kW » (monophasé 32 A = 7,4 kW).
  puissance_domicile_kw: 7.4,
  connecteurs_acceptes: ["CCS", "Type 2", "Mennekes"],
  prix_hc_eur_kwh: 0.21,
  prix_hp_eur_kwh: 0.27,
  part_hc_pct: 100,
  saison: "mi_saison",
};

// Modèle physique de consommation (calcul détaillé). Calibré ensuite sur
// la consommation déclarée du profil (à 90 km/h stabilisés, 20 °C, plat) :
// ces valeurs ne fixent que la FORME de la courbe, pas son niveau.
export const PHYSIQUE = {
  masse_base_kg: 1300,
  masse_par_kwh_batterie_kg: 7,
  masse_conducteur_kg: 80,
  coef_roulement: 0.011,
  surface_trainee_m2: 0.67,
  rendement_traction: 0.88,
  rendement_recuperation: 0.6,
  puissance_auxiliaire_base_kw: 0.25,
  vitesse_calibrage_kmh: 90,
  temperature_calibrage_c: 20,
  // chauffage : sous 18 °C ; clim : au-dessus de 24 °C
  chauffage_kw_par_degre: 0.15,
  chauffage_max_kw: 3.5,
  clim_kw_par_degre: 0.12,
  clim_max_kw: 1.5,
  // batterie froide : +1 %/°C sous 10 °C, plafonné à +15 %
  penalite_froid_par_degre: 0.01,
  penalite_froid_max: 0.15,
  // pluie : chaussée mouillée (+10 % de résistance au roulement, jusqu'à +30 %) + essuie-glaces/désembuage
  pluie_seuil_mm_h: 0.1,
  pluie_roulement_base: 0.1,
  pluie_roulement_par_mm: 0.05,
  pluie_roulement_max: 0.3,
  pluie_auxiliaire_kw: 0.1,
  // vent mesuré à 10 m, plus faible à hauteur de voiture
  facteur_vent_sol: 0.7,
  // ville (< 45 km/h) : arrêts/redémarrages
  penalite_ville: 0.15,
};

export const NB_MAX_ECHANTILLONS = 250;
export const NB_POINTS_METEO = 10;

export const PUISSANCE_LENTE_KW = 2.3;
export const FACTEUR_RALENTISSEMENT_DC = 1.5;
export const SEUIL_PUISSANCE_DC_KW = 40.0;
export const MARGE_SECURITE_PCT_DEFAUT = 10.0;
export const CIBLE_RECHARGE_PCT_DEFAUT = 80.0;
// Au dernier arrêt, on ne charge que pour arriver avec la marge de sécurité
// plus cette réserve (écart possible entre estimation et conduite réelle).
export const RESERVE_DERNIER_ARRET_PCT = 5.0;
export const MAX_ARRETS = 6;
export const PRIX_KWH_ESTIME_DEFAUT_EUR = 0.45;
export const SEUIL_PUISSANCE_CB_KW = 50.0;
export const MULTIPLICATEUR_CHARGE_LOURDE = 1.35;

export const MULTIPLICATEURS_SAISON = { ete: 1.0, mi_saison: 1.1, hiver: 1.25 };

export const PALIERS_TEMPERATURE = [
  [0, 1.30, "grand froid"],
  [10, 1.20, "froid"],
  [15, 1.10, "frais"],
  [25, 1.00, "température modérée"],
  [999, 1.05, "chaleur, climatisation"],
];

export const MODES_TRAJET = {
  rapide: { marge_pct: 8, cible_pct: 65, poids_puissance: 1.5, poids_cout: 0.5 },
  economique: { marge_pct: 10, cible_pct: 80, poids_puissance: 0.6, poids_cout: 1.6 },
  confort: { marge_pct: 12, cible_pct: 85, poids_puissance: 1.0, poids_cout: 0.8 },
  prudent: { marge_pct: 20, cible_pct: 90, poids_puissance: 1.0, poids_cout: 1.0 },
};
