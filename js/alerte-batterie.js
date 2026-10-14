// Alerte « batterie basse » : relit l'état réel du véhicule (Bluelink, via
// le relais partagé -- voir relais.js) à l'ouverture de l'appli, et prévient
// si la batterie est sous le seuil choisi dans Profil. Silencieux si le
// relais n'est pas configuré (aucune dépendance créée).

import { lireReglages } from "./storage.js";
import { relaisConfigure, lireEtatVehiculeRelais } from "./relais.js";
import { toast } from "./ui-commun.js";

const CLE_DERNIERE_ALERTE = "ev_derniere_alerte_batterie";
// Ne pas re-harceler à chaque réouverture : une alerte tient 2 h, sauf si
// la batterie a encore baissé depuis (ex. 18 % puis 10 % dans la même plage).
const DELAI_RE_ALERTE_MS = 2 * 60 * 60 * 1000;

export async function verifierBatterieBasse() {
  const reglages = lireReglages();
  if (reglages.alerte_batterie_activee === false || !relaisConfigure()) return;

  const etat = await lireEtatVehiculeRelais();
  if (!etat?.ok || typeof etat.batterie_pct !== "number") return;
  const seuil = reglages.alerte_batterie_seuil_pct ?? 20;
  if (etat.batterie_pct >= seuil || etat.en_charge) return;

  let derniere = {};
  try {
    derniere = JSON.parse(localStorage.getItem(CLE_DERNIERE_ALERTE) || "{}");
  } catch {
    derniere = {};
  }
  const recemment = Date.now() - (derniere.ts || 0) < DELAI_RE_ALERTE_MS;
  const pasPire = (derniere.pct ?? 100) <= etat.batterie_pct;
  if (recemment && pasPire) return;

  toast(`🔋 Batterie basse : ${Math.round(etat.batterie_pct)} % (${etat.nom_vehicule || "véhicule"})${etat.autonomie_km != null ? `, ~${etat.autonomie_km} km` : ""}.`);
  localStorage.setItem(CLE_DERNIERE_ALERTE, JSON.stringify({ ts: Date.now(), pct: etat.batterie_pct }));
}
