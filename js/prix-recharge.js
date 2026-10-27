// Comparateur de prix de recharge (projet séparé "comparateur-recharge-ve",
// backend FastAPI/PostgreSQL lancé sur le PC de l'utilisateur) -- intégré
// directement dans TrajetVE plutôt que dans un .apk séparé, demande
// explicite de l'utilisateur le 2026-10-27 : un seul APK à ouvrir. Le
// backend tourne en local (même Wi-Fi que le PC pour l'instant, pas encore
// de tunnel Cloudflare) -- réglages indépendants du reste de l'appli
// (localStorage dédié), pas de secret pour l'instant (réseau local
// uniquement, même étape que TrajetVE avant l'ajout de son secret de
// lecture -- à revoir si un accès distant est ajouté plus tard).

import { $ } from "./ui-commun.js";
import { escapeHtml } from "./util.js";

const CLE_SERVEUR = "pr_serveur_url";
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

async function lancerRecherche() {
  if (!serveurConfigure()) {
    afficherEcranPrix("reglages");
    return;
  }
  const kwh = Number($("pr-recherche-kwh").value) || 30;
  $("pr-recherche-statut").textContent = "Localisation en cours…";
  $("pr-recherche-note").classList.add("hidden");
  $("pr-liste-bornes").innerHTML = "";
  try {
    const { lat, lon } = await localiser();
    const p = new URLSearchParams({ lat, lon, rayon_km: 15, kwh });
    const bornes = await appel(`/bornes?${p}`);
    $("pr-recherche-statut").textContent = `${bornes.length} borne(s) trouvée(s) dans un rayon de 15 km, pour ${kwh} kWh.`;
    $("pr-recherche-note").classList.remove("hidden");
    rendreListeBornes(bornes, kwh);
  } catch (e) {
    $("pr-recherche-statut").textContent = e.message;
  }
}

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
    const prix =
      b.moins_cher_eur != null
        ? `<span class="pr-borne-prix">${b.moins_cher_eur.toFixed(2)} €<span class="pr-borne-prix-methode"> · ${escapeHtml(b.moins_cher_methode)}</span></span>`
        : `<span class="pr-borne-prix pr-borne-prix-inconnu">prix non calculable</span>`;
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

const LABELS_CONFIANCE = { confirmed: "confirmé", estimated: "estimé", brut_non_verifie: "non vérifié", non_calculable: "non calculable" };

async function afficherComparatifPrix(borne, kwh) {
  const conteneur = $("pr-comparatif-resultat");
  conteneur.innerHTML = "<p class='pr-vide'>Calcul en cours…</p>";
  try {
    const resultat = await appel("/prix/estimation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_station: borne.id_station, kwh }),
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
    conteneur.innerHTML = `
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

function ouvrirComparatif(borne, kwh) {
  $("pr-comparatif-titre").textContent = borne.nom || "Borne de recharge";
  $("pr-comparatif-kwh").value = kwh;
  afficherEcranPrix("comparatif");
  afficherComparatifPrix(borne, kwh);

  $("pr-comparatif-form").onsubmit = (e) => {
    e.preventDefault();
    afficherComparatifPrix(borne, Number($("pr-comparatif-kwh").value) || 30);
  };
  $("pr-comparatif-retour-btn").onclick = () => afficherEcranPrix("recherche");
}

export function cablerPrixRecharge() {
  $("pr-serveur-input").value = lireAdresseServeur();
  $("pr-reglages-ouvrir-btn").addEventListener("click", () => afficherEcranPrix("reglages"));
  $("pr-reglages-retour-btn").addEventListener("click", () => afficherEcranPrix("recherche"));
  $("pr-serveur-form").addEventListener("submit", (e) => {
    e.preventDefault();
    enregistrerAdresseServeur($("pr-serveur-input").value);
    afficherEcranPrix("recherche");
  });
  $("pr-chercher-btn").addEventListener("click", lancerRecherche);
  afficherEcranPrix(serveurConfigure() ? "recherche" : "reglages");
}
