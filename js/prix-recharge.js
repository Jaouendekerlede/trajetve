// Comparateur de prix de recharge -- intégré directement dans TrajetVE
// plutôt que dans un .apk séparé, demande explicite de l'utilisateur le
// 2026-10-27 : un seul APK à ouvrir. Backend : Worker Cloudflare + D1
// (...\Sauvegarde Projets 16-09-2026\ComparateurRecharge-Worker), gratuit
// et toujours disponible -- remplace le backend Python local (FastAPI/
// PostgreSQL) qui exigeait que le PC tourne en permanence sur le même
// Wi-Fi, jugé "pas pratique du tout" par l'utilisateur. Réglages
// indépendants du reste de l'appli (localStorage dédié), même principe que
// `relais_url` : adresse à coller une fois après déploiement du Worker, pas
// de valeur par défaut dans le code public (l'adresse du Worker contient
// l'identifiant du compte Cloudflare -- même blocage de sécurité déjà
// rencontré et contourné de la même façon pour le relais TrajetVE). Pas de
// secret de lecture : prix de bornes publiques, pas de donnée personnelle.

import { $ } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { obtenirProfilVehicule, ajouterAuJournal } from "./storage.js";
import { afficherBornesPrix } from "./carte.js";
import { trajetActuel, afficherVueBornes } from "./ui.js";

const CLE_SERVEUR = "pr_serveur_url";
const CLE_SECRET_ADMIN = "pr_admin_secret";
const DELAI_MS = 15000;

function lireAdresseServeur() {
  try {
    return (localStorage.getItem(CLE_SERVEUR) || "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function enregistrerAdresseServeur(url) {
  try {
    localStorage.setItem(CLE_SERVEUR, (url || "").trim().replace(/\/+$/, ""));
  } catch {
    // Sans conséquence : le réglage ne sera simplement pas mémorisé.
  }
}

function serveurConfigure() {
  return !!lireAdresseServeur();
}

function lireSecretAdmin() {
  try {
    return (localStorage.getItem(CLE_SECRET_ADMIN) || "").trim();
  } catch {
    return "";
  }
}

function enregistrerSecretAdmin(secret) {
  try {
    localStorage.setItem(CLE_SECRET_ADMIN, (secret || "").trim());
  } catch {
    // Sans conséquence : le réglage ne sera simplement pas mémorisé.
  }
}

async function appel(chemin, options = {}) {
  const base = lireAdresseServeur();
  if (!base) throw new Error("Adresse du serveur non configurée (voir Réglages ci-dessous).");
  const reponse = await fetch(`${base}${chemin}`, { ...options, signal: AbortSignal.timeout(DELAI_MS) });
  if (!reponse.ok) {
    const corps = await reponse.json().catch(() => ({}));
    throw new Error(corps.detail || `Erreur serveur (${reponse.status})`);
  }
  return reponse.json();
}

function localiser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("La géolocalisation n'est pas disponible sur cet appareil."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(`Position indisponible : ${err.message}`)),
      { enableHighAccuracy: true, timeout: DELAI_MS },
    );
  });
}

function afficherEcranPrix(nom) {
  for (const ecran of document.querySelectorAll(".pr-ecran")) {
    ecran.classList.toggle("hidden", ecran.id !== `pr-ecran-${nom}`);
  }
}

// kWh nécessaires estimés à partir du profil véhicule (capacité) et des
// jauges déjà saisies ailleurs dans l'appli (charge actuelle/cible) --
// évite de retaper un nombre à chaque recherche. Demande explicite de
// l'utilisateur le 2026-10-27.
function kwhSuggeres() {
  try {
    const actuel = Number($("ev-charge-pct-input")?.value);
    const cible = Number($("ev-cible-pct-input")?.value);
    const capacite = obtenirProfilVehicule().capacite_kwh;
    if (!Number.isFinite(actuel) || !Number.isFinite(cible) || !Number.isFinite(capacite) || cible <= actuel) return 30;
    return Math.max(1, Math.round(((cible - actuel) / 100) * capacite));
  } catch {
    return 30;
  }
}

let dernieresBornes = [];
let dernierKwh = 30;

async function rechercherDepuis(lat, lon) {
  const kwh = Number($("pr-recherche-kwh").value) || 30;
  dernierKwh = kwh;
  $("pr-recherche-statut").textContent = "Recherche en cours…";
  $("pr-recherche-note").classList.add("hidden");
  $("pr-liste-bornes").innerHTML = "";
  $("pr-voir-carte-btn").classList.add("hidden");
  try {
    const p = new URLSearchParams({ lat, lon, rayon_km: 15, kwh });
    const bornes = await appel(`/bornes?${p}`);
    dernieresBornes = bornes;
    $("pr-recherche-statut").textContent = `${bornes.length} borne(s) trouvée(s) dans un rayon de 15 km, pour ${kwh} kWh.`;
    $("pr-recherche-note").classList.remove("hidden");
    if (bornes.length) $("pr-voir-carte-btn").classList.remove("hidden");
    rendreListeBornes(bornes, kwh);
  } catch (e) {
    $("pr-recherche-statut").textContent = e.message;
  }
}

async function lancerRecherche() {
  if (!serveurConfigure()) {
    afficherEcranPrix("reglages");
    return;
  }
  $("pr-recherche-statut").textContent = "Localisation en cours…";
  try {
    const { lat, lon } = await localiser();
    await rechercherDepuis(lat, lon);
  } catch (e) {
    $("pr-recherche-statut").textContent = e.message;
  }
}

async function lancerRechercheDestination() {
  if (!serveurConfigure()) {
    afficherEcranPrix("reglages");
    return;
  }
  const trajet = trajetActuel();
  if (!trajet || !Number.isFinite(trajet.to_lat) || !Number.isFinite(trajet.to_lon)) {
    $("pr-recherche-statut").textContent = "Aucun trajet en cours (planifiez d'abord un trajet dans l'onglet Trajet).";
    return;
  }
  await rechercherDepuis(trajet.to_lat, trajet.to_lon);
}

const LABELS_CONFIANCE = { confirmed: "✓ confirmé", estimated: "≈ estimé", brut_non_verifie: "≈ non vérifié", non_calculable: "non calculable" };

function rendreListeBornes(bornes, kwh) {
  const conteneur = $("pr-liste-bornes");
  conteneur.innerHTML = "";
  if (!bornes.length) {
    conteneur.innerHTML = "<p class='pr-vide'>Aucune borne trouvée dans un rayon de 15 km.</p>";
    return;
  }
  for (const b of bornes) {
    const ligne = document.createElement("button");
    ligne.type = "button";
    ligne.className = "pr-borne";
    let prix = `<span class="pr-borne-prix pr-borne-prix-inconnu">prix non calculable</span>`;
    if (b.moins_cher_eur != null) {
      const fourchette = b.moins_cher_eur_max != null && b.moins_cher_eur_max !== b.moins_cher_eur ? `${b.moins_cher_eur.toFixed(2)}–${b.moins_cher_eur_max.toFixed(2)} €` : `${b.moins_cher_eur.toFixed(2)} €`;
      const badge = LABELS_CONFIANCE[b.moins_cher_confiance] || b.moins_cher_confiance;
      prix = `<span class="pr-borne-prix">${fourchette}<span class="pr-borne-prix-methode"> · ${escapeHtml(b.moins_cher_methode)}</span><span class="pr-badge pr-badge-${escapeHtml(b.moins_cher_confiance || "")}">${escapeHtml(badge)}</span></span>`;
    }
    ligne.innerHTML = `
      <span class="pr-borne-ligne1">
        <span class="pr-borne-nom">${escapeHtml(b.nom || "Borne de recharge")}</span>
        ${prix}
      </span>
      <span class="pr-borne-detail">${escapeHtml(b.operateur_brut || "Opérateur inconnu")} · ${b.distance_km ?? "?"} km${b.puissance_max_kw ? ` · ${Math.round(b.puissance_max_kw)} kW` : ""}</span>
    `;
    ligne.addEventListener("click", () => ouvrirComparatif(b, kwh));
    conteneur.appendChild(ligne);
  }
}

async function afficherComparatifPrix(borne, kwh, dureeBranchementMin) {
  const conteneur = $("pr-comparatif-resultat");
  conteneur.innerHTML = "<p class='pr-vide'>Calcul en cours…</p>";
  try {
    const resultat = await appel("/prix/estimation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_station: borne.id_station, kwh, duree_branchement_min: dureeBranchementMin ?? null }),
    });
    const lignes = resultat.quotes
      .map((q) => {
        const cout = q.cost_min === null ? "—" : q.cost_min === q.cost_max ? `${q.cost_min} €` : `${q.cost_min}–${q.cost_max} €`;
        const meilleur = q.payment_method === resultat.moins_cher;
        return `
          <tr class="${meilleur ? "pr-moins-cher" : ""}">
            <td>${escapeHtml(q.label)}${meilleur ? " 🏆" : ""}</td>
            <td>${cout}</td>
            <td class="pr-confiance">${LABELS_CONFIANCE[q.confidence] || q.confidence}</td>
          </tr>
          ${q.notes.map((n) => `<tr class="pr-note"><td colspan="3">ℹ️ ${escapeHtml(n)}</td></tr>`).join("")}
        `;
      })
      .join("");
    const notes = resultat.notes_incertitude.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
    const quoteRetenue = resultat.quotes.find((q) => q.payment_method === resultat.moins_cher);
    const alerte =
      quoteRetenue && quoteRetenue.confidence !== "confirmed"
        ? `<p class="pr-alerte">⚠️ Ce prix n'est pas confirmé par une facture réelle (${LABELS_CONFIANCE[quoteRetenue.confidence] || quoteRetenue.confidence}) -- le coût réel peut différer.</p>`
        : "";
    conteneur.innerHTML = `
      ${alerte}
      <table class="pr-table">
        <thead><tr><th>Moyen de paiement</th><th>Coût estimé</th><th>Confiance</th></tr></thead>
        <tbody>${lignes}</tbody>
      </table>
      ${notes ? `<ul class="pr-notes-incertitude">${notes}</ul>` : ""}
    `;
  } catch (e) {
    conteneur.innerHTML = `<p class="pr-erreur">${escapeHtml(e.message)}</p>`;
  }
}

function enregistrerRechargeReelle(borne) {
  const kwh = Number($("pr-journal-kwh").value);
  const cout = Number($("pr-journal-cout").value);
  if (!Number.isFinite(kwh) || !Number.isFinite(cout)) {
    $("pr-journal-statut").textContent = "kWh et prix payé requis.";
    return;
  }
  ajouterAuJournal({ lieu: borne.nom || "Borne de recharge", kwh, cout_eur: cout, source: "manuel" });
  $("pr-journal-statut").textContent = "Enregistré dans le journal (onglet Outils).";
  $("pr-journal-kwh").value = "";
  $("pr-journal-cout").value = "";
}

function ouvrirComparatif(borne, kwh) {
  $("pr-comparatif-titre").textContent = borne.nom || "Borne de recharge";
  $("pr-comparatif-kwh").value = kwh;
  $("pr-comparatif-duree").value = "";
  $("pr-journal-kwh").value = "";
  $("pr-journal-cout").value = "";
  $("pr-journal-statut").textContent = "";
  afficherEcranPrix("comparatif");
  afficherComparatifPrix(borne, kwh, null);

  $("pr-comparatif-form").onsubmit = (e) => {
    e.preventDefault();
    const duree = $("pr-comparatif-duree").value ? Number($("pr-comparatif-duree").value) : null;
    afficherComparatifPrix(borne, Number($("pr-comparatif-kwh").value) || 30, duree);
  };
  $("pr-journal-form").onsubmit = (e) => {
    e.preventDefault();
    enregistrerRechargeReelle(borne);
  };
  $("pr-comparatif-retour-btn").onclick = () => afficherEcranPrix("recherche");
}

async function signalerPrix() {
  const statut = $("pr-signaler-statut");
  const secret = lireSecretAdmin();
  if (!secret) {
    statut.textContent = "Mot de passe admin non configuré (voir Réglages → Signaler un prix).";
    return;
  }
  const operateur = $("pr-signaler-operateur").value.trim();
  const methode = $("pr-signaler-methode").value;
  const prix = Number($("pr-signaler-prix").value);
  const notes = $("pr-signaler-notes").value.trim();
  if (!operateur || !Number.isFinite(prix)) {
    statut.textContent = "Opérateur et prix au kWh requis.";
    return;
  }
  statut.textContent = "Envoi en cours…";
  try {
    await appel("/admin/signaler-prix", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ operateur, payment_method: methode, price_per_kwh: prix, notes }),
    });
    statut.textContent = "Règle enregistrée.";
    $("pr-signaler-operateur").value = "";
    $("pr-signaler-prix").value = "";
    $("pr-signaler-notes").value = "";
  } catch (e) {
    statut.textContent = e.message;
  }
}

export function cablerPrixRecharge() {
  $("pr-serveur-input").value = lireAdresseServeur();
  $("pr-secret-admin-input").value = lireSecretAdmin();
  $("pr-reglages-ouvrir-btn").addEventListener("click", () => afficherEcranPrix("reglages"));
  $("pr-reglages-retour-btn").addEventListener("click", () => afficherEcranPrix("recherche"));
  $("pr-signaler-ouvrir-btn").addEventListener("click", () => afficherEcranPrix("signaler"));
  $("pr-signaler-retour-btn").addEventListener("click", () => afficherEcranPrix("reglages"));
  $("pr-serveur-form").addEventListener("submit", (e) => {
    e.preventDefault();
    enregistrerAdresseServeur($("pr-serveur-input").value);
    enregistrerSecretAdmin($("pr-secret-admin-input").value);
    afficherEcranPrix("recherche");
  });
  $("pr-chercher-btn").addEventListener("click", lancerRecherche);
  $("pr-destination-btn").addEventListener("click", lancerRechercheDestination);
  $("pr-voir-carte-btn").addEventListener("click", () => {
    afficherBornesPrix(dernieresBornes);
    afficherVueBornes();
  });
  $("pr-recherche-kwh").value = kwhSuggeres();
  $("pr-signaler-form").addEventListener("submit", (e) => {
    e.preventDefault();
    signalerPrix();
  });
  afficherEcranPrix(serveurConfigure() ? "recherche" : "reglages");
}
