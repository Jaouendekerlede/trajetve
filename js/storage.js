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

const CHAMPS_NUMERIQUES = ["capacite_kwh", "consommation_kwh_100km", "puissance_ac_kw", "puissance_dc_kw", "puissance_domicile_kw", "prix_hc_eur_kwh", "prix_hp_eur_kwh"];

// Prix moyen payé à domicile, selon la part de recharge faite en heures
// creuses -- c'est lui qu'utilise la comparaison domicile/public de JARVIS.
function avecPrixDomicile(profil) {
  const partHc = Math.max(0, Math.min(100, Number(profil.part_hc_pct))) / 100;
  const prix = partHc * profil.prix_hc_eur_kwh + (1 - partHc) * profil.prix_hp_eur_kwh;
  return { ...profil, prix_domicile_eur_kwh: Math.round(prix * 10000) / 10000 };
}

// Version 2 du profil : Kona 65 kWh calée sur la fiche Hyundai (41 min de
// 10 à 80 %). Un profil enregistré avec l'ancienne valeur (77 kW) est mis à jour.
const VERSION_PROFIL = 2;

export function obtenirProfilVehicule() {
  const profil = lireJson(STORAGE_KEYS.profil, {});
  if ((profil.version_profil || 0) < VERSION_PROFIL && Object.keys(profil).length) {
    if (profil.puissance_dc_kw === 77) profil.puissance_dc_kw = PROFIL_PAR_DEFAUT.puissance_dc_kw;
    profil.version_profil = VERSION_PROFIL;
    ecrireJson(STORAGE_KEYS.profil, profil);
  }
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
  // Valeurs choisies par l'utilisateur : plus de mise à jour automatique.
  profil.version_profil = VERSION_PROFIL;
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

// Version 2 des réglages du trajet : 15 % de marge, recharge à 80 % (demande
// de l'utilisateur). Les anciens réglages enregistrés sont mis à jour une fois.
const VERSION_PREFS = 2;

export function lirePrefs() {
  const p = lireJson(STORAGE_KEYS.prefs, null);
  if (p && (p.version_reglages || 0) < VERSION_PREFS) {
    Object.assign(p, { marge_pct: 15, cible_pct: 80, version_reglages: VERSION_PREFS });
    if (p.mode === undefined || p.mode === "confort") p.mode = "confort";
    ecrireJson(STORAGE_KEYS.prefs, p);
  }
  return p;
}

export function sauverPrefs(prefs) {
  try {
    ecrireJson(STORAGE_KEYS.prefs, { ...prefs, version_reglages: VERSION_PREFS });
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

// ── Journal des recharges ──────────────────────────────────────────────────

const MAX_JOURNAL = 500;

export function listerJournal() {
  return lireJson(STORAGE_KEYS.journal, []);
}

// entree : { lieu, kwh, cout_eur, source: "navigation" | "manuel" }
export function ajouterAuJournal(entree) {
  const journal = listerJournal();
  // Identifiant unique même pour deux ajouts dans la même milliseconde.
  journal.unshift({ id: `recharge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...entree });
  ecrireJson(STORAGE_KEYS.journal, journal.slice(0, MAX_JOURNAL));
}

export function retirerDuJournal(id) {
  ecrireJson(STORAGE_KEYS.journal, listerJournal().filter((e) => e.id !== id));
}

// ── Abonnements de recharge ────────────────────────────────────────────────
// { reseau: "Ionity", prix: 0.39 } : sur les bornes de ce réseau, le prix
// de l'abonnement remplace le tarif public (et les estimations).

export function listerAbonnements() {
  return (lireReglages().abonnements || []).filter((a) => a.reseau && a.prix > 0);
}

export function sauverAbonnements(abonnements) {
  sauverReglages({ abonnements });
}

export function appliquerAbonnements(bornes) {
  const abonnements = listerAbonnements();
  if (!abonnements.length) return bornes;
  for (const b of bornes) {
    const noms = [b.operateur, b.officiel?.operateur, b.officiel?.enseigne, b.nom, b.nom_borne].filter(Boolean).join(" ").toLowerCase();
    const abo = abonnements.find((a) => noms.includes(a.reseau.trim().toLowerCase()));
    if (!abo) continue;
    b.prix_kwh_eur = abo.prix;
    b.prix_est_estimation = false;
    b.prix_source = "abonnement";
    b.abonnement = abo.reseau;
  }
  return bornes;
}

// ── Consommation mesurée en roulant ────────────────────────────────────────
// Chaque correction de batterie en navigation donne une mesure réelle :
// kWh consommés sur une distance connue.

const CLE_CONSO = "trajetve_conso_mesures";
const MAX_MESURES = 60;
const KM_MIN_MESURE = 20;
const KM_MIN_TOTAL = 50;

export function enregistrerMesureConso(km, kwh) {
  const kwh100 = (kwh / km) * 100;
  // Mesure trop courte ou invraisemblable (erreur de saisie) : ignorée.
  if (km < KM_MIN_MESURE || kwh100 < 6 || kwh100 > 45) return false;
  const mesures = lireJson(CLE_CONSO, []);
  mesures.unshift({ ts: Date.now(), km: Math.round(km * 10) / 10, kwh: Math.round(kwh * 100) / 100 });
  ecrireJson(CLE_CONSO, mesures.slice(0, MAX_MESURES));
  return true;
}

// Moyenne pondérée par la distance, ou null s'il n'y a pas assez de km.
export function consoMesuree() {
  const mesures = lireJson(CLE_CONSO, []);
  const km = mesures.reduce((s, m) => s + m.km, 0);
  if (km < KM_MIN_TOTAL) return null;
  const kwh = mesures.reduce((s, m) => s + m.kwh, 0);
  return { kwh_100km: Math.round((kwh / km) * 1000) / 10, km: Math.round(km), nb: mesures.length };
}

// ── Sauvegarde complète (changement de téléphone) ──────────────────────────
// Toutes les données de l'appli sont dans le localStorage sous des clés
// « trajetve_… » : on les exporte telles quelles dans un fichier.

const PREFIXE = "trajetve_";
const FORMAT_SAUVEGARDE = "trajetve-sauvegarde";

export function exporterDonnees() {
  const donnees = {};
  for (let i = 0; i < localStorage.length; i++) {
    const cle = localStorage.key(i);
    if (cle?.startsWith(PREFIXE)) donnees[cle] = localStorage.getItem(cle);
  }
  return { format: FORMAT_SAUVEGARDE, version: 1, date: new Date().toISOString(), donnees };
}

// Remplace les données de ce téléphone par celles du fichier. Renvoie le
// nombre d'éléments restaurés, ou lève une erreur si le fichier n'en est pas un.
export function importerDonnees(sauvegarde) {
  if (sauvegarde?.format !== FORMAT_SAUVEGARDE || typeof sauvegarde.donnees !== "object") {
    throw new Error("ce fichier n'est pas une sauvegarde Trajet VE");
  }
  const entrees = Object.entries(sauvegarde.donnees).filter(([cle, valeur]) => cle.startsWith(PREFIXE) && typeof valeur === "string");
  const anciennes = [];
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(PREFIXE)) anciennes.push(localStorage.key(i));
  for (const cle of anciennes) localStorage.removeItem(cle);
  for (const [cle, valeur] of entrees) localStorage.setItem(cle, valeur);
  return entrees.length;
}
// ── Routes coupées à éviter (marquées sur la carte avant le départ) ─────────

const MAX_ZONES_EVITEES = 5;
const DEMI_COTE_ZONE_EVITEE_M = 120;

export function listerZonesEvitees() {
  return lireJson(STORAGE_KEYS.zonesEvitees, []);
}

export function ajouterZoneEvitee(lat, lon) {
  const zones = [{ id: `zone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, lat, lon, date: Date.now() }, ...listerZonesEvitees()].slice(0, MAX_ZONES_EVITEES);
  ecrireJson(STORAGE_KEYS.zonesEvitees, zones);
  return zones;
}

export function retirerZoneEvitee(id) {
  const zones = listerZonesEvitees().filter((z) => z.id !== id);
  ecrireJson(STORAGE_KEYS.zonesEvitees, zones);
  return zones;
}

// Carrés de 240 m de côté, au format « avoidAreas » de TomTom.
export function rectanglesZonesEvitees() {
  return listerZonesEvitees().map(({ lat, lon }) => {
    const dLat = DEMI_COTE_ZONE_EVITEE_M / 111320;
    const dLon = DEMI_COTE_ZONE_EVITEE_M / (111320 * Math.cos((lat * Math.PI) / 180));
    return { southWestCorner: { latitude: lat - dLat, longitude: lon - dLon }, northEastCorner: { latitude: lat + dLat, longitude: lon + dLon } };
  });
}

// ── Où est garée la voiture (enregistré à l'arrivée d'une navigation) ───────

const CLE_VOITURE_GAREE = "trajetve_voiture_garee";

export function garerVoiture(lat, lon, lieu = "") {
  ecrireJson(CLE_VOITURE_GAREE, { lat, lon, lieu, date: Date.now() });
}

export function voitureGaree() {
  return lireJson(CLE_VOITURE_GAREE, null);
}

export function oublierVoitureGaree() {
  localStorage.removeItem(CLE_VOITURE_GAREE);
}

// ── Trajets faits en navigation (statistiques) ──────────────────────────────

const CLE_TRAJETS_FAITS = "trajetve_trajets_faits";
const MAX_TRAJETS_FAITS = 1000;

export function listerTrajetsFaits() {
  return lireJson(CLE_TRAJETS_FAITS, []);
}

export function ajouterTrajetFait(trajet) {
  ecrireJson(CLE_TRAJETS_FAITS, [{ date: Date.now(), ...trajet }, ...listerTrajetsFaits()].slice(0, MAX_TRAJETS_FAITS));
}
