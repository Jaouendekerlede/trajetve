// Profil › ☁️ Google Drive : connecter, sauvegarder, restaurer. Ensuite,
// sauvegarde automatique à la fin de chaque trajet guidé (« Terminer »).

import { $, toast, bandeau } from "./ui-commun.js";
import { exporterDonnees, importerDonnees, lireReglages, sauverReglages } from "./storage.js";
import { obtenirJeton, envoyerSauvegarde, lireSauvegarde } from "./drive.js";
import { empreinteDonnees } from "./restauration.js";

// Suivi (hors sauvegarde, propre à ce téléphone).
const CLE_SUIVI = "tve_drive";
const JOUR_MS = 24 * 3600000;

function suivi() {
  try {
    return JSON.parse(localStorage.getItem(CLE_SUIVI)) || {};
  } catch {
    return {};
  }
}

function majInfo() {
  const s = suivi();
  const el = $("ev-drive-info");
  if (!el) return;
  el.textContent = s.le ? `Dernière sauvegarde sur Drive : ${new Date(s.le).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : lireReglages().drive_client_id ? "Pas encore de sauvegarde sur Drive." : "Collez d'abord l'identifiant client Google (voir l'aide).";
}

export async function sauvegarderSurDrive({ silencieux = false } = {}) {
  const clientId = lireReglages().drive_client_id;
  try {
    const jeton = await obtenirJeton(clientId, { silencieux });
    const donnees = exporterDonnees();
    await envoyerSauvegarde(jeton, donnees);
    localStorage.setItem(CLE_SUIVI, JSON.stringify({ le: Date.now(), empreinte: empreinteDonnees(donnees.donnees) }));
    sauverReglages({ drive_actif: true });
    majInfo();
    toast("☁️ Sauvegardé sur Google Drive");
    return true;
  } catch (e) {
    if (!silencieux) toast(`⚠️ Drive : ${e.message}`);
    return false;
  }
}

async function restaurerDepuisDrive() {
  try {
    const jeton = await obtenirJeton(lireReglages().drive_client_id);
    const r = await lireSauvegarde(jeton);
    if (!r) return toast("☁️ Aucune sauvegarde trouvée sur ce compte Google.");
    const quand = new Date(r.date).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    if (!confirm(`Restaurer la sauvegarde Drive du ${quand} ? Les données de ce téléphone seront remplacées.`)) return;
    const idClient = lireReglages().drive_client_id;
    const n = importerDonnees(r.sauvegarde);
    // L'identifiant client reste, même si la sauvegarde n'en avait pas.
    if (!lireReglages().drive_client_id) sauverReglages({ drive_client_id: idClient, drive_actif: true });
    toast(`✅ ${n} éléments restaurés : redémarrage…`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(`⚠️ Drive : ${e.message}`);
  }
}

// Fin de trajet (appui sur « Terminer ») : sauvegarde si les données ont
// changé et que la dernière a plus d'un jour.
export function sauvegardeApresTrajet() {
  if (!lireReglages().drive_actif || !lireReglages().drive_client_id) return;
  const s = suivi();
  if (s.le && Date.now() - s.le < JOUR_MS && s.empreinte === empreinteDonnees(exporterDonnees().donnees)) return;
  sauvegarderSurDrive({ silencieux: true });
}

// À l'ouverture : plus de 7 jours sans sauvegarde Drive → un appui suffit.
export function proposerSauvegardeDrive() {
  if (!lireReglages().drive_actif) return;
  const s = suivi();
  if (s.le && Date.now() - s.le < 7 * JOUR_MS) return;
  if (s.empreinte && s.empreinte === empreinteDonnees(exporterDonnees().donnees)) return;
  bandeau({ id: "ev-bandeau-drive", texte: "☁️ Sauvegarder vos données sur Google Drive ?", boutons: [{ libelle: "Plus tard", secondaire: true }, { libelle: "Sauvegarder", action: () => sauvegarderSurDrive() }] });
}

export function cablerDrive() {
  $("ev-drive-client").value = lireReglages().drive_client_id || "";
  $("ev-drive-client").addEventListener("change", (e) => {
    sauverReglages({ drive_client_id: e.target.value.trim() });
    majInfo();
  });
  $("ev-drive-sauver-btn").addEventListener("click", () => sauvegarderSurDrive());
  $("ev-drive-restaurer-btn").addEventListener("click", restaurerDepuisDrive);
  majInfo();
}
