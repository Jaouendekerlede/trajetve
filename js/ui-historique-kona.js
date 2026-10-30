// Historique détaillé par trajet réel (Pleos : distance, vitesse max,
// température, avertissements) -- Menu › Mes trajets › 🔧 Historique
// détaillé (Kona). Volontairement séparé de "Mes statistiques" (vision
// globale par période) : ici, chaque trajet réel un par un, issu
// directement de Hyundai via le relais JARVIS. Demande explicite de
// l'utilisateur le 2026-10-26.

import { $, nombreAffiche } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { relaisConfigure, lireEtatVehiculeRelais } from "./relais.js";

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function rendreHistoriqueKona(trajets) {
  const conteneur = $("ev-historique-kona-liste");
  if (!conteneur) return;
  if (!relaisConfigure()) {
    conteneur.innerHTML = `<div class="ev-hint">Configure l'URL du relais dans 🚗 Profil pour voir ici l'historique réel des trajets.</div>`;
    return;
  }
  if (!trajets?.length) {
    conteneur.innerHTML = `<div class="ev-hint">Aucun trajet détecté par Hyundai pour l'instant sur les 6 derniers jours. Ça se remplit après un vrai trajet avec la voiture (et peut prendre jusqu'à 24 h après la première connexion Pleos).</div>`;
    return;
  }
  conteneur.innerHTML = trajets
    .map((t) => {
      const morceaux = [];
      if (Number.isFinite(t.km)) morceaux.push(`${nombreAffiche(t.km, 1)} km`);
      if (Number.isFinite(t.duree_min)) morceaux.push(`${nombreAffiche(t.duree_min, 1)} min`);
      if (Number.isFinite(t.vitesse_max_kmh)) morceaux.push(`${nombreAffiche(t.vitesse_max_kmh)} km/h max`);
      if (Number.isFinite(t.temperature_exterieure_c)) morceaux.push(`${nombreAffiche(Math.round(t.temperature_exterieure_c))} °C`);
      const avert = t.avertissements?.length ? ` · ⚠️ ${t.avertissements.length}` : "";
      return `<div class="ev-journal-ligne"><span>${escapeHtml(formatDate(t.debut))}</span><span>${escapeHtml(morceaux.join(" · ") || "Détails indisponibles")}${avert}</span></div>`;
    })
    .join("");
}

let derniereLectureHistoriqueKona = 0;
export async function rafraichirHistoriqueKona({ forcer = false } = {}) {
  if (!relaisConfigure()) return rendreHistoriqueKona(null);
  if (!forcer && Date.now() - derniereLectureHistoriqueKona < 60000) return;
  derniereLectureHistoriqueKona = Date.now();
  const etat = await lireEtatVehiculeRelais();
  rendreHistoriqueKona(etat?.ok ? etat.historique_trajets : null);
}
