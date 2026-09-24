// Persistance locale (localStorage) -- équivalent des fichiers JSON de
// JARVIS (config_store.read_json_file/write_json_file), mais par
// appareil : chaque téléphone/navigateur a sa propre copie, pas de
// serveur qui centraliserait quoi que ce soit.

import { STORAGE_KEYS, PROFIL_PAR_DEFAUT, MULTIPLICATEURS_SAISON } from "./config.js";

const MAX_HISTORIQUE_TRAJETS = 50;
const MAX_TRAJETS_FAVORIS = 30;

function lireJson(cle, defaut) {
  try {
    const brut = localStorage.getItem(cle);
    return brut ? JSON.parse(brut) : defaut;
  } catch {
    return defaut;
  }
}

function ecrireJson(cle, valeur) {
  localStorage.setItem(cle, JSON.stringify(valeur));
}

const CHAMPS_NUMERIQUES = ["capacite_kwh", "consommation_kwh_100km", "puissance_ac_kw", "puissance_dc_kw", "prix_hc_eur_kwh", "prix_hp_eur_kwh"];

// Prix moyen payé à domicile, selon la part de recharge faite en heures
// creuses -- c'est lui qu'utilise la comparaison domicile/public de JARVIS.
function avecPrixDomicile(profil) {
  const partHc = Math.max(0, Math.min(100, Number(profil.part_hc_pct))) / 100;
  const prix = partHc * profil.prix_hc_eur_kwh + (1 - partHc) * profil.prix_hp_eur_kwh;
  return { ...profil, prix_domicile_eur_kwh: Math.round(prix * 10000) / 10000 };
}

export function obtenirProfilVehicule() {
  const profil = lireJson(STORAGE_KEYS.profil, {});
  const fusion = { ...PROFIL_PAR_DEFAUT, ...profil };
  if (!(fusion.saison in MULTIPLICATEURS_SAISON)) {
    fusion.saison = "mi_saison";
  }
  return avecPrixDomicile(fusion);
}

export function definirProfilVehicule(champs) {
  const { prix_domicile_eur_kwh: _calcule, ...profil } = obtenirProfilVehicule();
  for (const cle of ["nom", ...CHAMPS_NUMERIQUES, "part_hc_pct"]) {
    if (champs[cle] !== undefined && champs[cle] !== null && champs[cle] !== "" && !Number.isNaN(champs[cle])) {
      profil[cle] = champs[cle];
    }
  }
  if (champs.saison && champs.saison in MULTIPLICATEURS_SAISON) {
    profil.saison = champs.saison;
  }
  if (Array.isArray(champs.connecteurs_acceptes) && champs.connecteurs_acceptes.length) {
    profil.connecteurs_acceptes = champs.connecteurs_acceptes.map((c) => String(c).trim()).filter(Boolean);
  }
  for (const cle of CHAMPS_NUMERIQUES) {
    profil[cle] = Math.max(0.01, parseFloat(profil[cle]));
  }
  profil.part_hc_pct = Math.max(0, Math.min(100, parseFloat(profil.part_hc_pct) || 0));
  ecrireJson(STORAGE_KEYS.profil, profil);
  return avecPrixDomicile(profil);
}

export function listerHistoriqueTrajets() {
  return lireJson(STORAGE_KEYS.historique, []);
}

export function enregistrerHistoriqueTrajet(depart, destination, resultat, reglages) {
  const historique = listerHistoriqueTrajets();
  const entree = {
    id: `trajet_${Date.now()}`,
    ts: Date.now() / 1000,
    depart,
    destination,
    from_name: resultat.from_name,
    to_name: resultat.to_name,
    distance_km: resultat.distance_km,
    duree_text: resultat.duree_text,
    nb_arrets: resultat.nb_arrets,
    pct_batterie_arrivee: resultat.pct_batterie_arrivee,
    reglages: reglages || {},
  };
  historique.unshift(entree);
  ecrireJson(STORAGE_KEYS.historique, historique.slice(0, MAX_HISTORIQUE_TRAJETS));
  return entree.id;
}

export function supprimerTrajetHistorique(entreeId) {
  const historique = listerHistoriqueTrajets().filter((h) => h.id !== entreeId);
  ecrireJson(STORAGE_KEYS.historique, historique);
  return historique;
}

export function effacerHistoriqueTrajets() {
  ecrireJson(STORAGE_KEYS.historique, []);
}

export function listerTrajetsFavoris() {
  return lireJson(STORAGE_KEYS.favoris, []);
}

export function ajouterTrajetFavori(depart, destination) {
  const favoris = listerTrajetsFavoris();
  const existe = favoris.some(
    (f) => f.depart.toLowerCase() === depart.toLowerCase() && f.destination.toLowerCase() === destination.toLowerCase(),
  );
  if (!existe) {
    favoris.unshift({ id: `fav_${Date.now()}`, depart, destination });
  }
  ecrireJson(STORAGE_KEYS.favoris, favoris.slice(0, MAX_TRAJETS_FAVORIS));
  return favoris;
}

export function retirerTrajetFavori(entreeId) {
  const favoris = listerTrajetsFavoris().filter((f) => f.id !== entreeId);
  ecrireJson(STORAGE_KEYS.favoris, favoris);
  return favoris;
}

function idBorne(nom, lat, lon) {
  return `${String(nom).trim().toLowerCase()}@${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

export function listerBornesFavorites() {
  return lireJson(STORAGE_KEYS.bornesFavorites, []);
}

export function estBorneFavorite(nom, lat, lon) {
  const id = idBorne(nom, lat, lon);
  return listerBornesFavorites().some((f) => f.id === id);
}

export function basculerFavoriBorne(nom, lat, lon, adresse = "") {
  let favoris = listerBornesFavorites();
  const id = idBorne(nom, lat, lon);
  if (favoris.some((f) => f.id === id)) {
    favoris = favoris.filter((f) => f.id !== id);
  } else {
    favoris.unshift({ id, nom, lat, lon, adresse });
  }
  ecrireJson(STORAGE_KEYS.bornesFavorites, favoris);
  return favoris;
}

export function obtenirNoteBorne(nom, lat, lon) {
  return lireJson(STORAGE_KEYS.bornesNotes, {})[idBorne(nom, lat, lon)] || "";
}

export function definirNoteBorne(nom, lat, lon, note) {
  const notes = lireJson(STORAGE_KEYS.bornesNotes, {});
  const id = idBorne(nom, lat, lon);
  if (note.trim()) notes[id] = note.trim();
  else delete notes[id];
  ecrireJson(STORAGE_KEYS.bornesNotes, notes);
}

export function lirePrefs() {
  return lireJson(STORAGE_KEYS.prefs, null);
}

export function sauverPrefs(prefs) {
  try {
    ecrireJson(STORAGE_KEYS.prefs, prefs);
  } catch {
    // simple confort : une écriture ratée ne doit rien casser
  }
}

const REGLAGES_PAR_DEFAUT = { adresse_domicile: "", annonce_vocale: true };

export function lireReglages() {
  return { ...REGLAGES_PAR_DEFAUT, ...lireJson(STORAGE_KEYS.reglages, {}) };
}

export function sauverReglages(reglages) {
  ecrireJson(STORAGE_KEYS.reglages, { ...lireReglages(), ...reglages });
}
