// Scan du QR code d'une borne de recharge : ouvre la caméra, lit le code
// (en général une URL du réseau de recharge pour démarrer la session sans
// badge), puis prépare le contexte avant d'y envoyer l'utilisateur --
// véhicule et batterie actuels, et si une borne connue (Open Charge Map)
// se trouve à l'endroit où le téléphone est scanné, ses infos (opérateur,
// puissance, prix, compatibilité du connecteur).
// Un vrai badge RFID ne peut pas être remplacé par un scan depuis une appli
// web (il s'active par contact radio avec la borne) -- seul le cas, courant,
// d'un QR code pour démarrer via le site du réseau est couvert ici.

import { $, toast } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { scanner, disponible } from "./scanner.js";
import { resoudreLieu } from "./geo.js";
import { rechercherBornesProches, borneCompatible } from "./ocm.js";
import { obtenirProfilVehicule } from "./storage.js";
import { getApiKeys } from "./config.js";

const RAYON_RECHERCHE_KM = 0.3; // 300 m : au-delà, on ne considère pas que c'est "cette" borne.

let controleur = null;

function fermer() {
  controleur?.abort();
  controleur = null;
  $("ev-scan-borne").classList.add("hidden");
  $("ev-scan-borne-resultat").classList.add("hidden");
  $("ev-scan-borne-resultat").innerHTML = "";
}

function ligneInfo(libelle, valeur) {
  return `<div class="ev-sos-ligne"><span>${escapeHtml(libelle)}</span><strong>${valeur}</strong></div>`;
}

async function traiterValeurScannee(valeur) {
  $("ev-scan-borne-statut").textContent = "🔎 Préparation de la recharge…";

  const profil = obtenirProfilVehicule();
  const chargeInput = $("ev-charge-pct-input");
  const batterie = chargeInput && chargeInput.value !== "" ? Number(chargeInput.value) : null;

  let borne = null;
  try {
    const pos = await resoudreLieu("ma position");
    if (!pos.erreur) {
      const { openChargeMap } = getApiKeys();
      if (openChargeMap) {
        const r = await rechercherBornesProches(openChargeMap, pos.lat, pos.lon, RAYON_RECHERCHE_KM, 1);
        if (r.ok && r.bornes.length && r.bornes[0].distance_km <= RAYON_RECHERCHE_KM) borne = r.bornes[0];
      }
    }
  } catch {
    // Position indisponible : on continue quand même avec ce qu'on a.
  }

  const lignes = [
    ligneInfo("Véhicule", escapeHtml(profil.nom || "Véhicule")),
    batterie !== null ? ligneInfo("Batterie", `${Math.round(batterie)} %`) : "",
  ];

  if (borne) {
    const compatible = borneCompatible(borne, profil.connecteurs_acceptes || []);
    lignes.push(
      ligneInfo("Borne reconnue", escapeHtml(borne.nom)),
      borne.operateur ? ligneInfo("Opérateur", escapeHtml(borne.operateur)) : "",
      ligneInfo("Puissance", `${Math.round(borne.puissance_max_kw)} kW`),
      ligneInfo("Connecteur", compatible ? "✅ Compatible avec ce véhicule" : "⚠️ Peut-être incompatible, vérifiez sur place"),
      borne.prix_kwh_eur ? ligneInfo("Prix estimé", `${borne.prix_kwh_eur.toFixed(2)} €/kWh${borne.prix_est_estimation ? " (estimation)" : ""}`) : "",
    );
  } else {
    lignes.push(`<div class="ev-hint">Aucune borne connue trouvée à cet endroit précis (position imprécise, ou borne absente d'Open Charge Map) -- les infos ci-dessus restent valables.</div>`);
  }

  const estUneUrl = /^https?:\/\//i.test(valeur.trim());
  const boutonReseau = estUneUrl
    ? `<a href="${escapeHtml(valeur.trim())}" target="_blank" rel="noopener" class="ev-btn ev-btn-plein">🔗 Ouvrir le site du réseau pour démarrer</a>`
    : `<div class="ev-hint">Code lu : « ${escapeHtml(valeur)} » (ne ressemble pas à un lien -- ouvrez l'appli du réseau de recharge concerné).</div>`;

  $("ev-scan-borne-statut").textContent = "";
  $("ev-scan-borne-resultat").innerHTML = lignes.join("") + boutonReseau;
  $("ev-scan-borne-resultat").classList.remove("hidden");
}

async function ouvrir() {
  $("ev-scan-borne").classList.remove("hidden");
  $("ev-scan-borne-resultat").classList.add("hidden");
  $("ev-scan-borne-resultat").innerHTML = "";

  if (!disponible()) {
    $("ev-scan-borne-statut").textContent = "⚠️ Caméra non accessible depuis ce navigateur.";
    return;
  }

  $("ev-scan-borne-statut").textContent = "Visez le QR code affiché sur la borne.";
  controleur = new AbortController();
  try {
    const { valeur } = await scanner($("ev-scan-video"), controleur.signal);
    navigator.vibrate?.(60);
    await traiterValeurScannee(valeur);
  } catch (e) {
    if (e.message === "scan annulé") return; // fermeture volontaire, rien à dire
    $("ev-scan-borne-statut").textContent = "⚠️ Code illisible ou caméra indisponible. Réessayez, ou rapprochez-vous du QR code.";
    toast("⚠️ Scan impossible, réessayez.");
  }
}

export function cablerScanBorne() {
  $("ev-scan-borne-ouvrir-btn").addEventListener("click", ouvrir);
  $("ev-scan-borne-fermer").addEventListener("click", fermer);
}
