// Alerte « entretien à prévoir » : relit le carnet d'entretien à l'ouverture
// de l'appli, et prévient si une échéance (date ou kilométrage) approche ou
// est dépassée. Même esprit que alerte-batterie.js, en séparant le calcul
// (pur, testable) de l'effet de bord (toast + stockage).

import { listerEntretien, obtenirProfilVehicule } from "./storage.js";
import { toast } from "./ui-commun.js";

// entretien : liste de listerEntretien(). aujourd'hui/kmActuel : à fournir
// explicitement (pas de Date.now()/lecture directe ici) pour rester testable
// sans horloge ni stockage. Renvoie les entrées dues, les plus urgentes
// d'abord (ordre d'arrivée dans la liste sinon).
export function elementsEntretienDus(entretien, { aujourdhui, kmActuel = null, delaiJours = 14, margeKm = 500 } = {}) {
  const limite = aujourdhui.getTime() + delaiJours * 86400000;
  return (entretien || []).filter((e) => {
    const parDate = Number.isFinite(e.prochaine_date_ts) && e.prochaine_date_ts <= limite;
    const parKm = Number.isFinite(e.prochain_km) && Number.isFinite(kmActuel) && e.prochain_km - kmActuel <= margeKm;
    return parDate || parKm;
  });
}

const CLE_DERNIERE_ALERTE = "ev_derniere_alerte_entretien";
// Pas de re-harcèlement à chaque réouverture dans la même journée.
const DELAI_RE_ALERTE_MS = 24 * 60 * 60 * 1000;

export function verifierEntretienDu() {
  const entretien = listerEntretien();
  if (!entretien.length) return;
  const kmActuel = obtenirProfilVehicule().kilometrage_actuel_km;
  const dus = elementsEntretienDus(entretien, { aujourdhui: new Date(), kmActuel });
  if (!dus.length) return;

  let derniere = {};
  try {
    derniere = JSON.parse(localStorage.getItem(CLE_DERNIERE_ALERTE) || "{}");
  } catch {
    derniere = {};
  }
  const ids = dus.map((e) => e.id).sort().join(",");
  const recemment = Date.now() - (derniere.ts || 0) < DELAI_RE_ALERTE_MS;
  if (recemment && derniere.ids === ids) return;

  const texte = dus.length === 1 ? dus[0].type : `${dus.length} échéances (${dus.map((e) => e.type).join(", ")})`;
  toast(`🔧 Entretien à prévoir : ${texte}.`);
  localStorage.setItem(CLE_DERNIERE_ALERTE, JSON.stringify({ ts: Date.now(), ids }));
}
