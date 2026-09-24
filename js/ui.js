// Interface -- reproduit le panneau Trajet VE de JARVIS (frontend/src/main.ts)
// en appelant directement le moteur local (trajet.js) au lieu du websocket.

import { getApiKeys, setApiKeys, MODES_TRAJET } from "./config.js";
import {
  obtenirProfilVehicule,
  definirProfilVehicule,
  listerHistoriqueTrajets,
  supprimerTrajetHistorique,
  effacerHistoriqueTrajets,
  listerTrajetsFavoris,
  ajouterTrajetFavori,
  retirerTrajetFavori,
  estBorneFavorite,
  basculerFavoriBorne,
  obtenirNoteBorne,
  definirNoteBorne,
  lirePrefs,
  sauverPrefs,
  lireReglages,
  sauverReglages,
} from "./storage.js";
import { planifierTrajet, planifierAllerRetour, comparerScenarios, bornesADistance, rechercherBornesAutour, bornesUrgence } from "./trajet.js";
import { typesDeCharge, calculerTempsCharge, exporterTrajetTexte, exporterScenariosTexte, formaterMinutes } from "./planner.js";
import { afficherTrajetSurCarte, masquerCarte, placerCurseur } from "./carte.js";
import { afficherCourbe, detruireCourbe } from "./courbe.js";
import { escapeHtml, lienGoogleMaps, lienWaze } from "./util.js";
import { enrichirBornes } from "./irve.js";

const $ = (id) => document.getElementById(id);
const LABELS_MODE = { rapide: "⚡ Rapide", economique: "💶 Économique", confort: "🛋️ Confort", prudent: "🛡️ Prudent" };
const BOUTONS_CALCUL = ["ev-trajet-run-btn", "ev-aller-retour-btn", "ev-scenarios-btn"];

let modeTrajet = "confort";
// Suit si marge/objectif ont été touchés à la main APRÈS le choix d'un mode :
// sans ça, recliquer sur un mode écraserait ces réglages sans prévenir.
let slidersModifiesManuellement = false;
let dernierTrajet = null;
let dernierChargeDepartPct = 80;
let dernierScenarios = null;
let derniereBorneOuverte = null;
let calculEnCours = false;

// ── Petits utilitaires d'affichage ─────────────────────────────────────────

function toast(message) {
  const el = $("ev-toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toast.minuteur);
  toast.minuteur = setTimeout(() => el.classList.remove("visible"), 2600);
}

function euros(x) {
  return `${Number(x).toFixed(2).replace(".", ",")} €`;
}

function nomCourt(nom) {
  const parts = String(nom || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  if (/^\d/.test(parts[0]) && parts[1]) return `${parts[0]} ${parts[1]}${parts[2] ? `, ${parts[2]}` : ""}`;
  return parts.slice(0, 2).join(", ");
}

function nombreOuUndefined(valeur) {
  const n = parseFloat(valeur);
  return Number.isFinite(n) ? n : undefined;
}

function setSlider(prefixe, valeur) {
  $(`${prefixe}-input`).value = String(valeur);
  $(`${prefixe}-value`).textContent = String(valeur);
}

function hint(texte) {
  return `<div class="ev-hint">${escapeHtml(texte)}</div>`;
}

function defiler(el) {
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Le bouton "retour" d'Android ferme la fenêtre ouverte au lieu de quitter l'appli.
function ouvrirOverlay(el) {
  el.classList.remove("hidden");
  if (!history.state?.overlay) history.pushState({ overlay: true }, "");
}
function fermerOverlays() {
  $("ev-station-modal").classList.add("hidden");
  $("ev-urgence-panel").classList.add("hidden");
}
function fermerOverlayDepuisBouton() {
  if (history.state?.overlay) history.back();
  else fermerOverlays();
}

// ── Jauge batterie, curseurs, modes ────────────────────────────────────────

function majJaugeBatterie() {
  const pct = parseFloat($("ev-charge-pct-input").value);
  const couleur = pct >= 50 ? "#22e5a0" : pct >= 20 ? "#ffcf70" : "#ff5c7a";
  const fill = $("ev-charge-pct-fill");
  fill.style.width = `${pct}%`;
  fill.style.background = couleur;
  fill.style.color = couleur;
}

function activerModeVisuel(mode) {
  document.querySelectorAll(".ev-charge-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

function appliquerPresetMode(mode) {
  const preset = MODES_TRAJET[mode];
  if (!preset) return;
  setSlider("ev-marge-pct", preset.marge_pct);
  setSlider("ev-cible-pct", preset.cible_pct);
}

function cablerCurseursEtModes() {
  $("ev-charge-pct-input").addEventListener("input", () => {
    $("ev-charge-pct-value").textContent = $("ev-charge-pct-input").value;
    majJaugeBatterie();
  });
  for (const prefixe of ["ev-marge-pct", "ev-cible-pct"]) {
    $(`${prefixe}-input`).addEventListener("input", () => {
      $(`${prefixe}-value`).textContent = $(`${prefixe}-input`).value;
      slidersModifiesManuellement = true;
    });
  }

  document.querySelectorAll(".ev-charge-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode || "confort";
      if (slidersModifiesManuellement) {
        const continuer = confirm("Tu as modifié la marge/l'objectif de charge à la main. Choisir un mode va remplacer ces réglages par ses valeurs par défaut. Continuer ?");
        if (!continuer) return;
      }
      modeTrajet = mode;
      slidersModifiesManuellement = false;
      activerModeVisuel(mode);
      appliquerPresetMode(mode);
      // Un trajet est déjà affiché : on le recalcule avec le nouveau mode
      // plutôt que de laisser l'ancien résultat à l'écran.
      if (dernierTrajet && $("ev-destination-input").value.trim()) lancerTrajet();
    });
  });
}

// ── Préférences mémorisées (confort, par appareil) ─────────────────────────

const CASES = {
  eviter_peages: "ev-eviter-peages-checkbox",
  eviter_ferries: "ev-eviter-ferries-checkbox",
  eviter_zones_faibles_emissions: "ev-eviter-zfe-checkbox",
  eviter_routes_non_revetues: "ev-eviter-non-revetues-checkbox",
  charge_lourde: "ev-charge-lourde-checkbox",
  modele_detaille: "ev-modele-detaille-checkbox",
  preferer_cb: "ev-preferer-cb-checkbox",
  ajuster_meteo: "ev-ajuster-meteo-checkbox",
};

function chargerPrefs() {
  const p = lirePrefs();
  if (p) {
    if (p.depart) $("ev-depart-input").value = p.depart;
    if (p.destination) $("ev-destination-input").value = p.destination;
    if (p.charge_pct !== undefined) setSlider("ev-charge-pct", p.charge_pct);
    if (p.mode && MODES_TRAJET[p.mode]) {
      modeTrajet = p.mode;
      activerModeVisuel(p.mode);
    }
    if (p.marge_pct !== undefined) setSlider("ev-marge-pct", p.marge_pct);
    if (p.cible_pct !== undefined) setSlider("ev-cible-pct", p.cible_pct);
    for (const [cle, id] of Object.entries(CASES)) if (p[cle] !== undefined) $(id).checked = !!p[cle];
    if (p.puissance_min_kw !== undefined) $("ev-puissance-min-input").value = String(p.puissance_min_kw);
    if (p.seuil_cout_eur !== undefined && p.seuil_cout_eur !== null) $("ev-seuil-cout-input").value = String(p.seuil_cout_eur);
    const preset = MODES_TRAJET[modeTrajet];
    slidersModifiesManuellement = preset && (preset.marge_pct !== Number(p.marge_pct ?? preset.marge_pct) || preset.cible_pct !== Number(p.cible_pct ?? preset.cible_pct));
  }
  majJaugeBatterie();
}

function construireOptions() {
  dernierChargeDepartPct = parseFloat($("ev-charge-pct-input").value);
  const seuil = parseFloat($("ev-seuil-cout-input").value);
  const options = {
    depart: $("ev-depart-input").value.trim() || "Ma position",
    destination: $("ev-destination-input").value.trim(),
    charge_pct: dernierChargeDepartPct,
    marge_pct: parseFloat($("ev-marge-pct-input").value),
    cible_pct: parseFloat($("ev-cible-pct-input").value),
    mode: modeTrajet,
    puissance_min_kw: parseFloat($("ev-puissance-min-input").value) || 0,
    seuil_cout_eur: Number.isFinite(seuil) ? seuil : null,
    depart_prevu: $("ev-depart-prevu-input").value || null,
  };
  for (const [cle, id] of Object.entries(CASES)) options[cle] = $(id).checked;
  return options;
}

function sauverPrefsDepuis(options) {
  const { depart_prevu: _ponctuel, ...aGarder } = options;
  sauverPrefs({ ...aGarder, seuil_cout_eur: $("ev-seuil-cout-input").value.trim() });
}

// ── Calculs ────────────────────────────────────────────────────────────────

async function avecVerrou(action) {
  if (calculEnCours) return;
  calculEnCours = true;
  BOUTONS_CALCUL.forEach((id) => ($(id).disabled = true));
  try {
    await action();
  } catch (e) {
    console.error(e);
    renderTrajet({ ok: false, erreur: `Erreur inattendue : ${e?.message || e}` });
  } finally {
    calculEnCours = false;
    BOUTONS_CALCUL.forEach((id) => ($(id).disabled = false));
  }
}

function preparerResultats(message) {
  $("ev-trajet-results").classList.remove("hidden");
  $("ev-trajet-summary").innerHTML = hint(message);
  $("ev-confiance-box").innerHTML = "";
  $("ev-domicile-box").classList.add("hidden");
  $("ev-cout-alerte").classList.add("hidden");
  $("ev-result-actions").classList.add("hidden");
  $("ev-qrcode-box").classList.add("hidden");
  $("ev-time-slider-row").classList.add("hidden");
  $("ev-profil-trajet").classList.add("hidden");
  detruireCourbe();
  $("ev-stops-title").classList.add("hidden");
  $("ev-trajet-stops").innerHTML = "";
}

function exigerDestination(options) {
  if (options.destination) return true;
  alert("Indique une destination.");
  $("ev-destination-input").focus();
  return false;
}

async function lancerTrajet() {
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou(async () => {
    preparerResultats("Calcul de l'itinéraire et des arrêts de recharge en cours...");
    sauverPrefsDepuis(options);
    const resultat = await planifierTrajet(options.depart, options.destination, options);
    renderTrajet(resultat);
    if (resultat.ok) {
      annoncer(resultat);
      rafraichirHistoriqueSiOuvert();
    }
  });
}

async function lancerAllerRetour() {
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou(async () => {
    preparerResultats("Calcul de l'aller et du retour en cours...");
    sauverPrefsDepuis(options);
    const { aller, retour } = await planifierAllerRetour(options.depart, options.destination, options);
    renderTrajet({ ...aller, retour });
    const texteRetour = retour.ok
      ? `↩️ Retour : ${retour.distance_km} km, ${retour.duree_text}, ${retour.nb_arrets} arrêt(s), arrivée à ${retour.pct_batterie_arrivee}%.`
      : `↩️ Retour impossible à calculer : ${retour.erreur}`;
    $("ev-trajet-summary").insertAdjacentHTML("beforeend", `<div class="ev-charge-retour-info">${escapeHtml(texteRetour)}</div>`);
    if (aller.ok) {
      annoncer(aller);
      rafraichirHistoriqueSiOuvert();
    }
  });
}

async function lancerScenarios() {
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou(async () => {
    const table = $("ev-scenarios-table");
    table.innerHTML = hint("Calcul des 4 scénarios en cours...");
    table.classList.remove("hidden");
    defiler(table);
    sauverPrefsDepuis(options);
    renderScenarios(await comparerScenarios(options.depart, options.destination, options));
  });
}

function annoncer(r) {
  if (!lireReglages().annonce_vocale || !("speechSynthesis" in window)) return;
  let phrase = `Trajet de ${nomCourt(r.from_name)} à ${nomCourt(r.to_name)} : ${Math.round(r.distance_km)} kilomètres, environ ${r.duree_text} de route.`;
  if (r.nb_arrets === 0) {
    phrase += ` Vous arrivez avec ${r.pct_batterie_arrivee}% de batterie, pas besoin de recharger.`;
  } else {
    const premier = r.arrets[0];
    phrase +=
      ` Il vous faudra ${r.nb_arrets} arrêt${r.nb_arrets > 1 ? "s" : ""} de recharge, le premier à ${premier.nom_borne}` +
      ` après ${Math.round(premier.km_depuis_depart)} kilomètres, environ ${premier.temps_charge_min} minutes de charge.` +
      ` Vous arriverez avec ${r.pct_batterie_arrivee}% de batterie.`;
  }
  const voix = new SpeechSynthesisUtterance(phrase);
  voix.lang = "fr-FR";
  speechSynthesis.cancel();
  speechSynthesis.speak(voix);
}

// ── Rendu du résultat ──────────────────────────────────────────────────────

function coutHtml(coutEstime, prixKwh, estimation) {
  if (coutEstime !== undefined && coutEstime !== null) {
    return `💶 ${estimation ? "~" : ""}${euros(coutEstime)}${estimation ? " (estimé, tarif réel non communiqué)" : ""}`;
  }
  if (prixKwh !== undefined && prixKwh !== null) return `💶 ~${euros(prixKwh)}/kWh${estimation ? " (estimé)" : ""}`;
  return "";
}

const OUI_NON = { oui: "✅ oui", partiel: "⚠️ sur une partie des points", non: "❌ non" };

function dateFr(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : d.toLocaleDateString("fr-FR");
}

function officielValide(b) {
  return b.officiel && !b.officiel.indisponible ? b.officiel : null;
}

// État "carte bancaire" le plus fiable disponible, toujours avec sa source.
function etatCb(b) {
  const o = officielValide(b);
  if (o) {
    if (o.paiement_cb === "oui") return { classe: "ok", court: "💳 CB acceptée", long: "✅ Acceptée" };
    if (o.paiement_cb === "partiel") return { classe: "warn", court: "💳 CB sur certains points", long: "⚠️ Sur une partie des points seulement" };
    return { classe: "non", court: "🚫 Pas de CB", long: "❌ Non acceptée" };
  }
  if (b.officiel === undefined) return { classe: "attente", court: "💳 CB : vérification…", long: "Vérification en cours…" };
  if (b.paiement_cb_probable) return { classe: "inconnu", court: "💳 CB probable (non confirmé)", long: "❓ Non confirmé — probable : borne ≥50 kW, terminal CB obligatoire sur les bornes neuves depuis 04/2024" };
  return { classe: "inconnu", court: "💳 CB : non renseigné", long: "❓ Non renseigné" };
}

function prixRetenuHtml(b) {
  if (b.prix_kwh_eur == null) return "";
  const source = b.prix_source === "officiel" ? "tarif officiel déclaré" : b.prix_est_estimation ? "estimation par défaut, tarif réel non communiqué" : "tarif Open Charge Map";
  return `${euros(b.prix_kwh_eur)}/kWh (${source})`;
}

function paiementLigneHtml(b) {
  const cb = etatCb(b);
  const o = officielValide(b);
  const morceaux = [`<span class="ev-cb-pill ${cb.classe}">${cb.court}</span>`];
  if (o) {
    if (o.gratuit === "oui") morceaux.push(`<span class="ev-cb-pill ok">🎁 Gratuit</span>`);
    morceaux.push(`<span>Sans abonnement : ${OUI_NON[o.paiement_acte]}</span>`);
    if (o.tarifs.length) morceaux.push(`<span>💶 ${escapeHtml(o.tarifs.slice(0, 2).join(" · "))}</span>`);
    if (o.horaires) morceaux.push(`<span>🕐 ${escapeHtml(o.horaires)}</span>`);
  }
  return `<div class="ev-paiement-ligne">${morceaux.join("")}</div>`;
}

function stationFactsHtml(b) {
  const connecteurs = (b.connecteurs || [])
    .map((c) => `<span class="ev-charge-connector-pill">${escapeHtml(c.type)} · ${escapeHtml(c.puissance_kw)} kW${c.quantite > 1 ? ` ×${escapeHtml(c.quantite)}` : ""}</span>`)
    .join("");
  const statutOk = (b.statut || "").toLowerCase().includes("operational");
  return `
    <div class="ev-charge-stop-facts">
      <span>${escapeHtml(b.operateur || officielValide(b)?.operateur || "Opérateur inconnu")}</span>
      <span class="ev-charge-status-pill ${statutOk ? "ok" : "warn"}">${escapeHtml(b.statut || "Statut inconnu")}</span>
      ${b.nombre_points ? `<span>${escapeHtml(b.nombre_points)} point(s)</span>` : ""}
    </div>
    ${paiementLigneHtml(b)}
    ${b.type_acces ? `<div class="ev-charge-stop-acces">🔑 ${escapeHtml(b.type_acces)}</div>` : ""}
    ${b.fraicheur ? `<div class="ev-charge-freshness ${escapeHtml(b.fraicheur.niveau)}">🕐 ${escapeHtml(b.fraicheur.label)}</div>` : ""}
    ${connecteurs ? `<div class="ev-charge-connectors">${connecteurs}</div>` : ""}
  `;
}

// Rubriques détaillées de la fiche borne, depuis la base officielle IRVE.
function sectionsOfficiellesHtml(b) {
  const ligne = (label, valeurHtml) =>
    valeurHtml ? `<div class="ev-station-detail-row"><span class="label">${label}</span><span class="value">${valeurHtml}</span></div>` : "";
  const section = (titre) => `<div class="ev-station-detail-section-title">${titre}</div>`;
  const o = officielValide(b);
  const cb = etatCb(b);

  let html = section("💳 Paiement");
  html += ligne("Carte bancaire", `<strong class="ev-cb-texte ${cb.classe}">${escapeHtml(cb.long)}</strong>`);
  if (o) {
    html += ligne("Paiement sans abonnement (à l'acte)", OUI_NON[o.paiement_acte]);
    html += ligne("Autres moyens (badge, appli, abonnement…)", OUI_NON[o.paiement_autre]);
    html += ligne("Recharge gratuite", OUI_NON[o.gratuit]);
    html += ligne("Tarif officiel déclaré", o.tarifs.length ? escapeHtml(o.tarifs.join(" · ")) : "Non communiqué");
  }
  if (b.cout_texte) html += ligne("Tarif Open Charge Map", escapeHtml(b.cout_texte));
  html += ligne("Prix utilisé pour le calcul", prixRetenuHtml(b));

  if (o) {
    html += section("🔌 Points de charge (officiel)");
    html += ligne("Nombre de points", escapeHtml(o.nombre_points));
    html += ligne("Puissance maximale", `${escapeHtml(o.puissance_max_kw)} kW`);
    for (const p of o.prises) html += ligne(escapeHtml(p.libelle), `${p.nombre} point(s), jusqu'à ${escapeHtml(p.puissance_max_kw)} kW`);
    if (o.cable_attache !== "non") html += ligne("Câble Type 2 attaché", OUI_NON[o.cable_attache]);
    if (o.deux_roues === "oui") html += ligne("Adaptée aux deux-roues", OUI_NON.oui);

    html += section("🕐 Accès");
    html += ligne("Conditions d'accès", escapeHtml(o.condition_acces));
    html += ligne("Horaires", escapeHtml(o.horaires));
    html += ligne("Réservation possible", OUI_NON[o.reservation]);
    html += ligne("Accessibilité PMR", escapeHtml(o.accessibilite_pmr));
    html += ligne("Restriction de gabarit", escapeHtml(o.restriction_gabarit));
    html += ligne("Emplacement", escapeHtml(o.implantation));
    html += ligne("Adresse déclarée", escapeHtml(o.adresse));

    html += section("🏢 Opérateur");
    html += ligne("Opérateur", escapeHtml(o.operateur));
    if (o.enseigne && o.enseigne !== o.operateur) html += ligne("Enseigne", escapeHtml(o.enseigne));
    if (o.amenageur && o.amenageur !== o.operateur) html += ligne("Propriétaire (aménageur)", escapeHtml(o.amenageur));
    if (o.telephone) html += ligne("Téléphone (assistance)", `<a href="${escapeHtml(o.telephone.lien)}">${escapeHtml(o.telephone.affichage)}</a>`);
    if (o.contact) {
      const contact = o.contact.includes("@") ? `<a href="mailto:${escapeHtml(o.contact)}">${escapeHtml(o.contact)}</a>` : escapeHtml(o.contact);
      html += ligne("Contact", contact);
    }
    if (o.observations) html += ligne("Remarques de l'opérateur", escapeHtml(o.observations));
    if (o.date_mise_en_service) html += ligne("Mise en service", dateFr(o.date_mise_en_service));
    if (o.date_maj) html += ligne("Dernière mise à jour officielle", dateFr(o.date_maj));
    html += hint(
      `Source : Base nationale officielle des bornes (IRVE, data.gouv.fr), déclarée par l'opérateur — station « ${o.nom_station || o.id_station} » à ${o.distance_m} m de ce point.` +
        (o.points_consultes < o.nombre_points ? ` Détail établi sur ${o.points_consultes} des ${o.nombre_points} points.` : ""),
    );
  } else if (b.officiel?.indisponible) {
    html += hint("Base officielle des bornes momentanément injoignable : réessaie plus tard pour voir le paiement CB, les horaires et l'accès.");
  } else if (b.officiel === null) {
    html += hint("Aucune déclaration officielle trouvée à moins de 150 m (borne hors de France, très récente ou non déclarée) : informations Open Charge Map uniquement.");
  }
  return html;
}

function tuile(couleur, icone, valeur, label) {
  return `<div class="ev-charge-summary-tile tile-${couleur}"><span class="tile-icon">${icone}</span><span class="tile-value">${escapeHtml(valeur)}</span><span class="tile-label">${escapeHtml(label)}</span></div>`;
}

function renderTrajet(p) {
  $("ev-trajet-results").classList.remove("hidden");
  if (!p.ok) {
    $("ev-trajet-summary").innerHTML = `<div class="ev-charge-cout-alerte">Erreur : ${escapeHtml(p.erreur || "inconnue")}</div>`;
    $("ev-confiance-box").innerHTML = "";
    ["ev-domicile-box", "ev-cout-alerte", "ev-result-actions", "ev-qrcode-box", "ev-time-slider-row", "ev-profil-trajet", "ev-stops-title"].forEach((id) =>
      $(id).classList.add("hidden"),
    );
    detruireCourbe();
    $("ev-trajet-stops").innerHTML = "";
    masquerCarte();
    dernierTrajet = null;
    defiler($("ev-trajet-results"));
    return;
  }

  afficherTrajetSurCarte(p, (arret) => ouvrirDetailBorne(arret, arret));
  $("ev-maps-link").href = lienGoogleMaps(p.to_lat, p.to_lon);
  $("ev-result-actions").classList.remove("hidden");
  $("ev-qrcode-box").classList.add("hidden");
  $("ev-qrcode-box").innerHTML = "";

  const pctArrivee = p.pct_batterie_arrivee;
  const couleurBatterie = pctArrivee >= 50 ? "good" : pctArrivee >= 20 ? "warn" : "bad";
  const tuiles = [
    tuile("cyan", "🛣️", `${p.distance_km} km`, "Distance"),
    tuile("violet", "⏱️", p.duree_text, "Route"),
    p.duree_totale_min != null ? tuile("cyan", "🏁", formaterMinutes(p.duree_totale_min), "Total porte-à-porte") : "",
    tuile(
      p.nb_arrets === 0 ? "good" : "warn",
      "🔌",
      p.nb_arrets === 0 ? "Aucun" : String(p.nb_arrets),
      `${p.nb_arrets === 0 ? "Arrêt" : "Arrêt(s)"}${p.temps_charge_total_min ? ` · ${p.temps_charge_total_min} min` : ""}`,
    ),
    tuile(couleurBatterie, "🔋", `${pctArrivee}%`, "À l'arrivée"),
    p.cout_total_eur ? tuile(p.depasse_seuil_cout ? "bad" : "good", "💶", euros(p.cout_total_eur), "Coût estimé") : "",
  ].join("");

  let meteo = "";
  if (p.meteo_info) {
    meteo = p.meteo_info.ok
      ? `🌡️ Météo au départ : ${p.meteo_info.temperature_c} °C (${p.meteo_info.description}) — consommation ×${p.meteo_info.multiplicateur}`
      : "🌡️ Météo indisponible : le réglage saisonnier du profil a été utilisé.";
  }

  $("ev-trajet-summary").innerHTML = `
    <div class="ev-charge-summary-route" title="${escapeHtml(p.from_name)} → ${escapeHtml(p.to_name)}">📍 ${escapeHtml(nomCourt(p.from_name))} <span class="arrow">→</span> ${escapeHtml(nomCourt(p.to_name))}</div>
    <div class="ev-charge-summary-grid">${tuiles}</div>
    ${meteo ? `<div class="ev-meteo-info">${escapeHtml(meteo)}</div>` : ""}
  `;

  const alerte = $("ev-cout-alerte");
  alerte.textContent = p.depasse_seuil_cout ? `⚠️ Le coût estimé de ce trajet (${euros(p.cout_total_eur)}) dépasse le seuil que tu as fixé.` : "";
  alerte.classList.toggle("hidden", !p.depasse_seuil_cout);

  if (p.confiance) {
    const c = p.confiance;
    const couleur = c.score >= 70 ? "good" : c.score >= 40 ? "warn" : "bad";
    $("ev-confiance-box").innerHTML = `
      <div class="ev-charge-score-badge tile-${couleur}">Confiance du trajet : ${c.score}/100</div>
      <div class="ev-charge-confiance-details">
        ${c.details.map((d) => `<span>${d.points >= 0 ? "+" : ""}${d.points} ${escapeHtml(d.label)}</span>`).join("")}
      </div>`;
  }

  const domicile = $("ev-domicile-box");
  const d = p.comparaison_domicile;
  if (d && d.economie_eur > 0.5) {
    const detailHcHp =
      d.cout_hc_eur != null
        ? `${euros(d.cout_hc_eur)} en heures creuses (${euros(d.prix_hc_eur_kwh)}/kWh) ou ${euros(d.cout_hp_eur)} en heures pleines (${euros(d.prix_hp_eur_kwh)}/kWh)`
        : `${euros(d.cout_domicile_eur)} (${euros(d.prix_domicile_eur_kwh)}/kWh)`;
    domicile.innerHTML =
      `💡 Recharger ces ${d.kwh} kWh à domicile coûterait ${detailHcHp}, contre ${euros(d.cout_public_eur)} en public.` +
      `<br>Économie estimée : <strong>${euros(d.economie_eur)}</strong>${d.part_hc_pct != null ? ` (avec ${escapeHtml(d.part_hc_pct)} % de recharge en heures creuses)` : ""}.`;
    domicile.classList.remove("hidden");
  } else {
    domicile.classList.add("hidden");
  }

  const arrets = p.arrets || [];
  $("ev-stops-title").classList.remove("hidden");
  $("ev-trajet-stops").innerHTML = arrets.length
    ? arrets
        .map(
          (a, i) => `
      <div class="ev-charge-stop-card ev-charge-stop-clickable" data-idx="${i}">
        <div class="ev-charge-stop-header">
          <span class="ev-charge-stop-num">Arrêt ${a.numero}</span>
          <span class="ev-charge-stop-km">km ${a.km_depuis_depart}</span>
        </div>
        <div class="ev-charge-stop-name">🔌 ${escapeHtml(a.nom_borne)} ${typeof a.score === "number" ? `<span class="ev-charge-score-pill">${a.score}/100</span>` : ""}</div>
        <div class="ev-charge-stop-addr">${escapeHtml(a.adresse || "")}</div>
        ${stationFactsHtml(a)}
        <div class="ev-charge-stop-meta">
          <span>+${a.kwh_ajoutes} kWh</span>
          <span>${a.puissance_kw} kW</span>
          <span>${a.temps_charge_min} min</span>
          <span>${a.pct_arrivee_borne}% → ${a.pct_depart_borne}%</span>
        </div>
        <div class="ev-charge-stop-cost">${coutHtml(a.cout_estime_eur, a.prix_kwh_eur, a.prix_est_estimation)}</div>
      </div>`,
        )
        .join("")
    : `<div class="ev-charge-stop-card">✅ Aucune recharge nécessaire : autonomie suffisante, arrivée avec ${pctArrivee}% de batterie.</div>`;
  $("ev-trajet-stops")
    .querySelectorAll(".ev-charge-stop-clickable")
    .forEach((el) => el.addEventListener("click", () => {
      const arret = arrets[Number(el.dataset.idx)];
      ouvrirDetailBorne(arret, arret);
    }));

  // Frise "où serai-je ?" : seulement si un tracé réel existe.
  if (p.coords && p.coords.length && p.duree_min) {
    dernierTrajet = p;
    renderProfilTrajet(p);
    $("ev-time-slider-row").classList.remove("hidden");
    $("ev-timeline-stops").innerHTML = arrets
      .map((a) => {
        const pct = (minutesDepuisKm(p, a.km_depuis_depart) / p.duree_min) * 100;
        return `<div class="ev-charge-timeline-stop" style="left:${pct}%" data-km="${a.km_depuis_depart}" title="Arrêt ${a.numero} : ${escapeHtml(a.nom_borne)} (km ${a.km_depuis_depart})">🔋</div>`;
      })
      .join("");
    $("ev-timeline-stops")
      .querySelectorAll(".ev-charge-timeline-stop")
      .forEach((el) =>
        el.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          sauterFriseAuKm(parseFloat(el.dataset.km || "0"));
        }),
      );
    $("ev-time-slider-stations").innerHTML = "";
    deplacerFrise(0);
  } else {
    dernierTrajet = null;
    $("ev-time-slider-row").classList.add("hidden");
    $("ev-profil-trajet").classList.add("hidden");
    detruireCourbe();
  }

  defiler(document.querySelector(".ev-carte-wrap"));
}

// ── Profil du trajet : statistiques et courbes au km ───────────────────────

let vueCourbe = "batterie";

function statistique(icone, texte) {
  return `<span>${icone} ${texte}</span>`;
}

function renderProfilTrajet(p) {
  const pt = p.profil_trajet;
  const section = $("ev-profil-trajet");
  if (!pt) {
    section.classList.add("hidden");
    detruireCourbe();
    return;
  }
  section.classList.remove("hidden");
  const s = pt.stats;
  const nombre = (x, dec = 0) => Number(x).toFixed(dec).replace(".", ",");
  const stats = [
    statistique("⚡", `<strong>${nombre(s.conso_moyenne_kwh100, 1)}</strong> kWh/100 km en moyenne`),
    statistique("🔋", `<strong>${nombre(s.energie_totale_kwh, 1)}</strong> kWh au total`),
  ];
  if (s.vitesse_moyenne_kmh) stats.push(statistique("🚗", `<strong>${nombre(s.vitesse_moyenne_kmh)}</strong> km/h de moyenne`));
  if (pt.relief_ok) {
    stats.push(statistique("⛰️", `+<strong>${nombre(s.denivele_positif_m)}</strong> m / −<strong>${nombre(s.denivele_negatif_m)}</strong> m`));
    stats.push(statistique("🏔️", `alt. max <strong>${nombre(s.altitude_max_m)}</strong> m`));
  }
  if (pt.meteo_ok) {
    stats.push(statistique("🌡️", `<strong>${nombre(s.temperature_min)}</strong> à <strong>${nombre(s.temperature_max)}</strong> °C`));
    stats.push(statistique("🌧️", s.km_sous_la_pluie > 0.5 ? `pluie sur <strong>${nombre(s.km_sous_la_pluie)}</strong> km` : "pas de pluie prévue"));
    const vent = s.vent_face_moyen_kmh;
    stats.push(statistique("💨", Math.abs(vent) < 3 ? "vent neutre" : `vent ${vent > 0 ? "de face" : "dans le dos"} ~<strong>${nombre(Math.abs(vent))}</strong> km/h`));
  }
  $("ev-profil-stats").innerHTML = stats.join("");

  const notes = [];
  if (p.modele === "detaille") {
    notes.push("Consommation calculée tronçon par tronçon : vitesse (limitations et trafic TomTom)");
    notes.push(pt.relief_ok ? "relief" : "relief indisponible (trajet supposé plat)");
    notes.push(pt.meteo_ok ? "météo à l'heure de passage (chauffage, clim, pluie, vent)" : "réglage saisonnier du profil");
  } else {
    notes.push("Consommation constante (mode JARVIS) — coche « Calcul détaillé » dans les options avancées pour tenir compte de la vitesse et du relief");
  }
  $("ev-profil-note").textContent = `ℹ️ ${notes.join(", ")}. Estimation : la conduite réelle peut s'en écarter.`;

  afficherVueCourbe();
}

function afficherVueCourbe() {
  const pt = dernierTrajet?.profil_trajet;
  document.querySelectorAll(".ev-courbe-btn").forEach((b) => b.classList.toggle("active", b.dataset.vue === vueCourbe));
  const vide = $("ev-courbe-vide");
  const conteneur = document.querySelector(".ev-courbe-wrap");
  let message = "";
  if (!pt) message = "Profil indisponible.";
  else if (!window.Chart) message = "Courbes indisponibles (pas de connexion pour charger le module graphique).";
  else if (vueCourbe === "meteo" && !pt.meteo_ok) message = "Coche « 🌦️ Météo réelle sur tout le trajet » dans les options avancées, puis relance le calcul, pour voir température, pluie et vent le long du trajet.";
  vide.textContent = message;
  vide.classList.toggle("hidden", !message);
  conteneur.classList.toggle("hidden", !!message);
  if (message) {
    detruireCourbe();
    return;
  }
  afficherCourbe($("ev-courbe-canvas"), pt, dernierTrajet.arrets, vueCourbe, (km) => sauterFriseAuKm(km));
}

function cablerCourbes() {
  document.querySelectorAll(".ev-courbe-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      vueCourbe = btn.dataset.vue;
      afficherVueCourbe();
    }),
  );
}

// ── Scénarios ──────────────────────────────────────────────────────────────

function renderScenarios(payload) {
  const table = $("ev-scenarios-table");
  if (!payload.ok) {
    table.innerHTML = `<div class="ev-charge-cout-alerte">Erreur : ${escapeHtml(payload.erreur || "inconnue")}</div>`;
    return;
  }
  dernierScenarios = payload;
  const colonnes = Object.entries(payload.scenarios)
    .map(([mode, r]) => {
      if (!r.ok) {
        return `<div class="ev-charge-scenario-col"><div class="ev-charge-scenario-mode">${LABELS_MODE[mode] || mode}</div>${hint(r.erreur || "Erreur")}</div>`;
      }
      return `
      <div class="ev-charge-scenario-col">
        <div class="ev-charge-scenario-mode">${LABELS_MODE[mode] || mode}</div>
        <div class="ev-charge-scenario-row"><span>🏁 Total</span><strong>${formaterMinutes(r.duree_totale_min ?? 0)}</strong></div>
        <div class="ev-charge-scenario-row"><span>⏱️ Charge</span><strong>${r.temps_charge_total_min} min</strong></div>
        <div class="ev-charge-scenario-row"><span>💶 Coût</span><strong>${euros(r.cout_total_eur)}</strong></div>
        <div class="ev-charge-scenario-row"><span>🔋 Arrivée</span><strong>${r.pct_batterie_arrivee}%</strong></div>
        <div class="ev-charge-scenario-row"><span>🔌 Arrêts</span><strong>${r.nb_arrets}</strong></div>
        <div class="ev-charge-scenario-row"><span>✅ Confiance</span><strong>${r.confiance?.score ?? "?"}/100</strong></div>
        <button type="button" class="ev-btn-secondaire ev-charge-scenario-choisir" data-mode="${mode}">✅ Choisir</button>
      </div>`;
    })
    .join("");
  table.innerHTML = `
    <div class="ev-charge-scenarios-header">
      <span>📊 Comparaison des scénarios</span>
      <button type="button" id="ev-scenarios-export-btn" class="ev-btn-secondaire">⬇️ Exporter</button>
    </div>
    <div class="ev-charge-scenarios-grid">${colonnes}</div>`;

  table.querySelectorAll(".ev-charge-scenario-choisir").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode || "confort";
      modeTrajet = mode;
      slidersModifiesManuellement = false;
      activerModeVisuel(mode);
      appliquerPresetMode(mode);
      renderTrajet(payload.scenarios[mode]);
    });
  });
  $("ev-scenarios-export-btn").addEventListener("click", () => {
    if (!dernierScenarios) return;
    telechargerTexte(`trajet_ve_scenarios_${Date.now()}.txt`, exporterScenariosTexte(dernierScenarios.depart, dernierScenarios.destination, dernierScenarios.scenarios));
  });
}

// ── Export, partage, QR code ───────────────────────────────────────────────

function telechargerTexte(nomFichier, texte) {
  const url = URL.createObjectURL(new Blob([texte], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nomFichier;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Fichier enregistré dans Téléchargements.");
}

function cablerActionsResultat() {
  $("ev-export-btn").addEventListener("click", () => {
    if (dernierTrajet) telechargerTexte(`trajet_ve_${Date.now()}.txt`, exporterTrajetTexte(dernierTrajet));
  });

  $("ev-partager-btn").addEventListener("click", async () => {
    if (!dernierTrajet) return;
    const sujet = `Trajet électrique : ${nomCourt(dernierTrajet.from_name)} → ${nomCourt(dernierTrajet.to_name)}`;
    const texte = exporterTrajetTexte(dernierTrajet);
    if (navigator.share) {
      try {
        await navigator.share({ title: sujet, text: texte });
      } catch (e) {
        if (e.name !== "AbortError") toast("Partage impossible sur cet appareil.");
      }
    } else {
      location.href = `mailto:?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(texte)}`;
    }
  });

  $("ev-qrcode-btn").addEventListener("click", () => {
    if (!dernierTrajet) return;
    const box = $("ev-qrcode-box");
    const texte = `Trajet : ${nomCourt(dernierTrajet.from_name)} -> ${nomCourt(dernierTrajet.to_name)} (${dernierTrajet.distance_km} km). Destination : ${lienGoogleMaps(dernierTrajet.to_lat, dernierTrajet.to_lon)}`;
    box.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(texte)}" alt="QR code du trajet" width="220" height="220">`;
    box.classList.toggle("hidden");
  });
}

// ── Frise chronologique "où serai-je ?" ────────────────────────────────────

function estimerBatteriePourDistance(distanceKm, p, chargeDepartPct) {
  // Courbe réelle du plan (vitesse, relief, météo, remontées aux arrêts).
  const courbe = p.profil_trajet?.batterie;
  if (courbe && courbe.length > 1) {
    for (let i = courbe.length - 1; i > 0; i--) {
      const a = courbe[i - 1];
      const b = courbe[i];
      if (distanceKm >= a.km && distanceKm <= b.km) {
        return b.km > a.km ? a.pct + ((b.pct - a.pct) * (distanceKm - a.km)) / (b.km - a.km) : b.pct;
      }
    }
    return courbe[courbe.length - 1].pct;
  }
  const autonomieTotale = p.autonomie_totale_km || 1;
  let departKm = 0;
  let departPct = chargeDepartPct;
  for (const a of p.arrets || []) {
    if (distanceKm <= a.km_depuis_depart) return departPct - ((distanceKm - departKm) / autonomieTotale) * 100;
    departKm = a.km_depuis_depart;
    departPct = a.pct_depart_borne;
  }
  return departPct - ((distanceKm - departKm) / autonomieTotale) * 100;
}

// Table temps ↔ distance tirée du profil de vitesse (sinon vitesse moyenne
// constante, comme JARVIS), recalée sur la durée totale TomTom.
function tableTemps(p) {
  if (p._tableTemps !== undefined) return p._tableTemps;
  const seg = p.profil_trajet?.segments;
  if (!seg || !seg.length || !p.duree_min) return (p._tableTemps = null);
  const km = [0];
  const min = [0];
  for (const s of seg) {
    km.push(s.km_fin);
    min.push(min[min.length - 1] + ((s.km_fin - s.km_debut) / Math.max(s.vitesse, 1)) * 60);
  }
  const echelle = p.duree_min / Math.max(1e-6, min[min.length - 1]);
  return (p._tableTemps = { km, min: min.map((m) => m * echelle) });
}

function interpoler(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / Math.max(1e-9, xs[i] - xs[i - 1]);
  }
  return ys[ys.length - 1];
}

function kmDepuisMinutes(p, minutes) {
  const table = tableTemps(p);
  if (table) return interpoler(table.min, table.km, minutes);
  return p.duree_min > 0 ? (Math.max(0, Math.min(1, minutes / p.duree_min)) * p.distance_km) : 0;
}

function minutesDepuisKm(p, km) {
  const table = tableTemps(p);
  if (table) return interpoler(table.km, table.min, km);
  return p.distance_km > 0 ? (km / p.distance_km) * p.duree_min : 0;
}

function deplacerFrise(minutes) {
  const t = dernierTrajet;
  if (!t) return;
  const ratio = t.duree_min > 0 ? Math.max(0, Math.min(1, minutes / t.duree_min)) : 0;
  $("ev-timeline-puck").style.left = `${ratio * 100}%`;
  $("ev-timeline-fill").style.width = `${ratio * 100}%`;
  const km = kmDepuisMinutes(t, ratio * t.duree_min);
  $("ev-time-slider-value").textContent = minutes <= 0.5 ? "Départ" : `${formaterMinutes(minutes)} · km ${Math.round(km)}`;
  const pct = estimerBatteriePourDistance(km, t, dernierChargeDepartPct);
  $("ev-timeline-battery-estimate").textContent = `🔋 ~${Math.round(pct)}%`;
}

let minuteurFrise = null;
let jetonFrise = 0;

function demanderBornesADistance(minutes) {
  if (!dernierTrajet) return;
  clearTimeout(minuteurFrise);
  minuteurFrise = setTimeout(async () => {
    const jeton = ++jetonFrise;
    const trajet = dernierTrajet;
    $("ev-time-slider-stations").innerHTML = hint("Recherche des bornes à ce point du trajet...");
    const r = await bornesADistance(trajet, kmDepuisMinutes(trajet, minutes));
    if (jeton === jetonFrise && trajet === dernierTrajet) renderBornesADistance(r);
  }, 250);
}

function sauterFriseAuKm(km) {
  if (!dernierTrajet) return;
  const minutes = minutesDepuisKm(dernierTrajet, km);
  deplacerFrise(minutes);
  demanderBornesADistance(minutes);
}

function cablerFrise() {
  const piste = $("ev-timeline-track");
  let glissement = false;

  const minutesDepuisX = (clientX) => {
    const rect = piste.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (dernierTrajet?.duree_min || 0);
  };
  const bouger = (clientX) => {
    if (!dernierTrajet) return;
    const minutes = minutesDepuisX(clientX);
    deplacerFrise(minutes);
    demanderBornesADistance(minutes);
  };
  // Relâche toujours la capture du pointeur (pointerup/pointercancel) : un
  // glissement interrompu ne doit jamais laisser la frise bloquée.
  const terminer = (e) => {
    if (!glissement) return;
    glissement = false;
    try {
      piste.releasePointerCapture(e.pointerId);
    } catch {
      /* déjà relâché */
    }
    bouger(e.clientX);
  };

  piste.addEventListener("pointerdown", (e) => {
    glissement = true;
    try {
      piste.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    bouger(e.clientX);
  });
  piste.addEventListener("pointermove", (e) => glissement && bouger(e.clientX));
  piste.addEventListener("pointerup", terminer);
  piste.addEventListener("pointercancel", terminer);
}

function contenuCarteBorne(b, etiquetteDistance) {
  return `
      <div class="ev-charge-stop-header">
        <span class="ev-charge-stop-num">🔌 ${escapeHtml(b.nom)}</span>
        <span class="ev-charge-stop-km">${escapeHtml(b.distance_km)} km${etiquetteDistance}</span>
      </div>
      <div class="ev-charge-stop-addr">${escapeHtml(b.adresse || "")}</div>
      ${stationFactsHtml(b)}
      <div class="ev-charge-stop-meta"><span>${escapeHtml(b.puissance_max_kw)} kW max</span></div>
      <div class="ev-charge-stop-cost">${coutHtml(undefined, b.prix_kwh_eur, b.prix_est_estimation)}${b.prix_source === "officiel" ? " (tarif officiel)" : ""}</div>`;
}

let jetonListe = 0;

function listeBornes(conteneur, bornes, etiquetteDistance, messageVide) {
  conteneur.innerHTML =
    bornes.map((b, i) => `<div class="ev-charge-stop-card ev-charge-stop-clickable" data-idx="${i}">${contenuCarteBorne(b, etiquetteDistance)}</div>`).join("") ||
    hint(messageVide);
  conteneur.querySelectorAll(".ev-charge-stop-clickable").forEach((el) => {
    el.addEventListener("click", () => ouvrirDetailBorne(bornes[Number(el.dataset.idx)]));
  });

  // Complète chaque carte avec les données officielles, par groupes de 5 ;
  // s'arrête si une nouvelle liste a remplacé celle-ci entre-temps.
  const jeton = String(++jetonListe);
  conteneur.dataset.jeton = jeton;
  (async () => {
    for (let k = 0; k < bornes.length; k += 5) {
      const groupe = bornes.slice(k, k + 5);
      await enrichirBornes(groupe);
      if (conteneur.dataset.jeton !== jeton) return;
      groupe.forEach((b, j) => {
        const carte = conteneur.querySelector(`.ev-charge-stop-clickable[data-idx="${k + j}"]`);
        if (carte) carte.innerHTML = contenuCarteBorne(b, etiquetteDistance);
      });
    }
  })();
}

function renderBornesADistance(r) {
  const zone = $("ev-time-slider-stations");
  if (!r.ok) {
    zone.innerHTML = hint(`Erreur : ${r.erreur || "inconnue"}`);
    placerCurseur(undefined, undefined);
    return;
  }
  placerCurseur(r.lat, r.lon, `À ce point du trajet (km ${r.distance_cible_km})`);
  listeBornes(zone, r.bornes || [], " à l'écart", "Aucune borne trouvée à proximité de ce point.");
}

// ── Fiche détaillée d'une borne ────────────────────────────────────────────

function ouvrirDetailBorne(borne, contexteArret) {
  $("ev-station-modal-title").textContent = borne.nom_borne || borne.nom || "Borne de recharge";
  const ligne = (label, valeurHtml) =>
    valeurHtml ? `<div class="ev-station-detail-row"><span class="label">${label}</span><span class="value">${valeurHtml}</span></div>` : "";
  const section = (titre) => `<div class="ev-station-detail-section-title">${titre}</div>`;

  let html = "";
  html += ligne("Adresse", escapeHtml(borne.adresse || "Non renseignée"));
  html += ligne("Opérateur", escapeHtml(borne.operateur || "Inconnu"));
  html += ligne("Statut déclaré", escapeHtml(borne.statut || "Inconnu"));
  if (borne.nombre_points) html += ligne("Nombre de points", escapeHtml(borne.nombre_points));
  if (borne.distance_km !== undefined) html += ligne("Distance au point recherché", `${escapeHtml(borne.distance_km)} km`);
  if (borne.distance_borne_km !== undefined) html += ligne("Écart par rapport au trajet", `${escapeHtml(borne.distance_borne_km)} km`);
  if (borne.puissance_max_kw) html += ligne("Puissance max", `${escapeHtml(borne.puissance_max_kw)} kW`);
  if (borne.type_acces) html += ligne("Type d'accès", escapeHtml(borne.type_acces));
  if (borne.fraicheur) html += ligne("Fraîcheur Open Charge Map", escapeHtml(borne.fraicheur.label));

  html += `<div id="ev-station-officiel">${
    borne.officiel === undefined ? hint("🔎 Recherche des informations officielles (paiement CB, tarifs, horaires, accès)…") : sectionsOfficiellesHtml(borne)
  }</div>`;

  if (contexteArret) {
    html += section("Plan de recharge à cet arrêt");
    html += ligne("Distance depuis le départ", `${contexteArret.km_depuis_depart} km`);
    html += ligne("Énergie à ajouter", `${contexteArret.kwh_ajoutes} kWh`);
    html += ligne("Temps de charge estimé", `${contexteArret.temps_charge_min} min`);
    html += ligne("Batterie à l'arrivée à la borne", `${contexteArret.pct_arrivee_borne}%`);
    html += ligne("Batterie au départ de la borne", `${contexteArret.pct_depart_borne}%`);

    if (typeof contexteArret.score === "number") {
      html += section("Score de recommandation");
      html += `<div class="ev-charge-score-badge">${contexteArret.score}/100</div>`;
      for (const d of contexteArret.score_details || []) {
        html += ligne(escapeHtml(d.label), `${d.points >= 0 ? "+" : ""}${d.points}`);
      }
    }
    const alternatives = contexteArret.alternatives || [];
    if (alternatives.length) {
      html += section("Alternatives à cet arrêt (plan B) — touche pour la fiche");
      alternatives.forEach((alt, i) => {
        const cb = etatCb(alt);
        html += `<div class="ev-alternative" data-alt="${i}">
          <div><strong>${escapeHtml(alt.nom)}</strong> <span class="ev-charge-stop-km">(${escapeHtml(alt.operateur || "opérateur ?")})</span></div>
          <div class="ev-charge-stop-meta"><span>${escapeHtml(alt.distance_km)} km</span><span>${escapeHtml(alt.puissance_max_kw)} kW</span><span>score ${alt.score}/100</span><span class="ev-cb-pill ${cb.classe}">${cb.court}</span></div>
        </div>`;
      });
    }
  }

  const connecteurs = borne.connecteurs || [];
  if (connecteurs.length) {
    html += section("Connecteurs");
    for (const c of connecteurs) html += ligne(escapeHtml(c.type), `${escapeHtml(c.puissance_kw)} kW × ${escapeHtml(c.quantite)} · ${escapeHtml(c.statut)}`);
  }

  if (borne.cout_estime_eur != null) {
    html += section("Coût de cet arrêt");
    html += ligne("Coût estimé de la recharge", coutHtml(borne.cout_estime_eur, borne.prix_kwh_eur, borne.prix_est_estimation));
  }

  if (borne.lat !== undefined && borne.lon !== undefined) {
    html += `<div class="ev-charge-nav-links">
      <a href="${lienGoogleMaps(borne.lat, borne.lon)}" target="_blank" rel="noopener" class="ev-btn-secondaire">🗺️ Google Maps</a>
      <a href="${lienWaze(borne.lat, borne.lon)}" target="_blank" rel="noopener" class="ev-btn-secondaire">🚗 Waze</a>
    </div>`;
  }
  html += hint("ℹ️ Occupation en temps réel non disponible (Open Charge Map est un registre statique, pas un flux live).");

  $("ev-station-modal-body").innerHTML = html;
  $("ev-station-modal-body")
    .querySelectorAll(".ev-alternative")
    .forEach((el) => el.addEventListener("click", () => ouvrirDetailBorne(contexteArret.alternatives[Number(el.dataset.alt)])));
  derniereBorneOuverte = { nom: borne.nom_borne || borne.nom || "", lat: borne.lat, lon: borne.lon, adresse: borne.adresse || "" };
  $("ev-station-note-input").value = obtenirNoteBorne(derniereBorneOuverte.nom, derniereBorneOuverte.lat, derniereBorneOuverte.lon);
  majBoutonFavoriBorne();
  ouvrirOverlay($("ev-station-modal"));
  $("ev-station-modal-body").scrollTop = 0;

  if (borne.officiel === undefined) {
    const ouverte = derniereBorneOuverte;
    enrichirBornes([borne]).then(() => {
      if (derniereBorneOuverte === ouverte && $("ev-station-officiel")) $("ev-station-officiel").innerHTML = sectionsOfficiellesHtml(borne);
    });
  }
}

function majBoutonFavoriBorne() {
  if (!derniereBorneOuverte) return;
  const b = derniereBorneOuverte;
  const favori = estBorneFavorite(b.nom, b.lat, b.lon);
  const btn = $("ev-station-modal-fav-btn");
  btn.textContent = favori ? "★" : "☆";
  btn.classList.toggle("active", favori);
}

function cablerFicheBorne() {
  $("ev-station-modal-close-btn").addEventListener("click", fermerOverlayDepuisBouton);
  $("ev-station-modal").addEventListener("click", (e) => {
    if (e.target === $("ev-station-modal")) fermerOverlayDepuisBouton();
  });
  $("ev-station-modal-fav-btn").addEventListener("click", () => {
    if (!derniereBorneOuverte) return;
    const b = derniereBorneOuverte;
    basculerFavoriBorne(b.nom, b.lat, b.lon, b.adresse);
    majBoutonFavoriBorne();
    toast(estBorneFavorite(b.nom, b.lat, b.lon) ? "Borne ajoutée aux favoris." : "Borne retirée des favoris.");
  });
  $("ev-station-note-save-btn").addEventListener("click", () => {
    if (!derniereBorneOuverte) return;
    const b = derniereBorneOuverte;
    definirNoteBorne(b.nom, b.lat, b.lon, $("ev-station-note-input").value || "");
    const btn = $("ev-station-note-save-btn");
    btn.textContent = "✅ Enregistré";
    setTimeout(() => (btn.textContent = "Enregistrer la note"), 1500);
  });
}

// ── Historique et favoris de trajets ───────────────────────────────────────

function chargerEtLancerTrajet(depart, destination, reglages) {
  $("ev-depart-input").value = depart;
  $("ev-destination-input").value = destination;
  if (reglages) {
    if (reglages.mode && MODES_TRAJET[reglages.mode]) {
      modeTrajet = reglages.mode;
      activerModeVisuel(reglages.mode);
    }
    if (reglages.marge_pct !== undefined) setSlider("ev-marge-pct", reglages.marge_pct);
    if (reglages.cible_pct !== undefined) setSlider("ev-cible-pct", reglages.cible_pct);
    if (reglages.charge_pct !== undefined) {
      setSlider("ev-charge-pct", reglages.charge_pct);
      majJaugeBatterie();
    }
    if (reglages.eviter_peages !== undefined) $("ev-eviter-peages-checkbox").checked = !!reglages.eviter_peages;
    if (reglages.puissance_min_kw !== undefined) $("ev-puissance-min-input").value = String(reglages.puissance_min_kw);
  }
  $("ev-panel-historique").classList.add("hidden");
  $("ev-panel-favoris").classList.add("hidden");
  lancerTrajet();
}

function renderHistorique() {
  const historique = listerHistoriqueTrajets();
  const liste = $("ev-historique-list");
  liste.innerHTML =
    historique
      .map(
        (h, i) => `
    <div class="ev-charge-stop-card ev-charge-stop-clickable" data-idx="${i}">
      <div class="ev-charge-stop-header">
        <span class="ev-charge-stop-num">${escapeHtml(nomCourt(h.from_name) || h.depart)} → ${escapeHtml(nomCourt(h.to_name) || h.destination)}</span>
        <button type="button" class="ev-charge-mini-btn ev-charge-hist-delete" data-id="${escapeHtml(h.id)}" title="Supprimer">🗑️</button>
      </div>
      <div class="ev-charge-stop-meta"><span>${escapeHtml(h.distance_km)} km</span><span>${escapeHtml(h.duree_text || "")}</span><span>${escapeHtml(h.nb_arrets)} arrêt(s)</span>${
        h.reglages?.mode ? `<span>${escapeHtml(LABELS_MODE[h.reglages.mode] || h.reglages.mode)}</span>` : ""
      }<span>${new Date(h.ts * 1000).toLocaleDateString("fr-FR")}</span></div>
    </div>`,
      )
      .join("") || hint("Aucun trajet calculé pour le moment.");
  liste.querySelectorAll(".ev-charge-hist-delete").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      supprimerTrajetHistorique(btn.dataset.id);
      renderHistorique();
    }),
  );
  liste.querySelectorAll(".ev-charge-stop-clickable").forEach((el) =>
    el.addEventListener("click", () => {
      const h = historique[Number(el.dataset.idx)];
      chargerEtLancerTrajet(h.depart, h.destination, h.reglages);
    }),
  );
}

function rafraichirHistoriqueSiOuvert() {
  if (!$("ev-panel-historique").classList.contains("hidden")) renderHistorique();
}

function renderFavoris() {
  const favoris = listerTrajetsFavoris();
  const liste = $("ev-favoris-list");
  liste.innerHTML =
    favoris
      .map(
        (f, i) => `
    <div class="ev-charge-stop-card ev-charge-stop-clickable" data-idx="${i}">
      <div class="ev-charge-stop-header">
        <span class="ev-charge-stop-num">⭐ ${escapeHtml(f.depart)} → ${escapeHtml(f.destination)}</span>
        <button type="button" class="ev-charge-mini-btn ev-charge-fav-delete" data-id="${escapeHtml(f.id)}" title="Retirer">🗑️</button>
      </div>
    </div>`,
      )
      .join("") || hint("Aucun trajet favori pour le moment.");
  liste.querySelectorAll(".ev-charge-fav-delete").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      retirerTrajetFavori(btn.dataset.id);
      renderFavoris();
    }),
  );
  liste.querySelectorAll(".ev-charge-stop-clickable").forEach((el) =>
    el.addEventListener("click", () => {
      const f = favoris[Number(el.dataset.idx)];
      chargerEtLancerTrajet(f.depart, f.destination);
    }),
  );
}

function cablerHistoriqueFavoris() {
  $("ev-historique-btn").addEventListener("click", () => {
    $("ev-panel-favoris").classList.add("hidden");
    $("ev-panel-historique").classList.remove("hidden");
    renderHistorique();
  });
  $("ev-historique-close-btn").addEventListener("click", () => $("ev-panel-historique").classList.add("hidden"));
  $("ev-historique-clear-btn").addEventListener("click", () => {
    if (confirm("Effacer tout l'historique des trajets ?")) {
      effacerHistoriqueTrajets();
      renderHistorique();
    }
  });
  $("ev-favoris-btn").addEventListener("click", () => {
    $("ev-panel-historique").classList.add("hidden");
    $("ev-panel-favoris").classList.remove("hidden");
    renderFavoris();
  });
  $("ev-favoris-close-btn").addEventListener("click", () => $("ev-panel-favoris").classList.add("hidden"));
  $("ev-favori-trajet-btn").addEventListener("click", () => {
    const destination = $("ev-destination-input").value.trim();
    if (!destination) {
      alert("Indique une destination avant de l'ajouter aux favoris.");
      return;
    }
    ajouterTrajetFavori($("ev-depart-input").value.trim() || "Ma position", destination);
    if (!$("ev-panel-favoris").classList.contains("hidden")) renderFavoris();
    toast("⭐ Trajet ajouté aux favoris.");
  });
}

// ── Mode urgence ───────────────────────────────────────────────────────────

function renderUrgence(r) {
  const corps = $("ev-urgence-body");
  if (!r.ok) {
    corps.innerHTML = `<div class="ev-charge-cout-alerte">Erreur : ${escapeHtml(r.erreur || "inconnue")}</div>`;
    return;
  }
  const bornes = (r.bornes || []).slice(0, 3);
  if (!bornes.length) {
    corps.innerHTML = hint("Aucune borne compatible trouvée dans un rayon de 30 km. Élargis le rayon depuis l'onglet 🔍 Bornes.");
    return;
  }
  corps.innerHTML =
    hint(`Autour de : ${nomCourt(r.lieu)}`) +
    bornes
      .map(
        (b, i) => `
    <div class="ev-charge-urgence-card ${i === 0 ? "principale" : ""}">
      <div class="ev-charge-urgence-title">${i === 0 ? "🎯 RECOMMANDÉE" : "🔁 Solution de secours"} : ${escapeHtml(b.nom)}</div>
      <div class="ev-charge-stop-addr">${escapeHtml(b.adresse || "")}</div>
      ${stationFactsHtml(b)}
      <div class="ev-charge-stop-meta"><span>${escapeHtml(b.distance_km)} km</span><span>${escapeHtml(b.puissance_max_kw)} kW</span></div>
      <div class="ev-charge-nav-links">
        <a href="${lienGoogleMaps(b.lat, b.lon)}" target="_blank" rel="noopener" class="ev-btn-secondaire">🗺️ Naviguer (Maps)</a>
        <a href="${lienWaze(b.lat, b.lon)}" target="_blank" rel="noopener" class="ev-btn-secondaire">🚗 Naviguer (Waze)</a>
      </div>
    </div>`,
      )
      .join("");
}

function cablerUrgence() {
  $("ev-urgence-btn").addEventListener("click", async () => {
    ouvrirOverlay($("ev-urgence-panel"));
    $("ev-urgence-body").innerHTML = hint("Recherche des bornes compatibles les plus proches de ta position...");
    renderUrgence(await bornesUrgence($("ev-depart-input").value.trim()));
  });
  $("ev-urgence-close-btn").addEventListener("click", fermerOverlayDepuisBouton);
}

// ── Calculateur rapide ─────────────────────────────────────────────────────

function cablerCalculateur() {
  $("ev-calc-run-btn").addEventListener("click", () => {
    const types = typesDeCharge(obtenirProfilVehicule());
    const type = types[$("ev-calc-type-select").value] || types.rapide;
    const kwh = parseFloat($("ev-calc-kwh-input").value) || 0;
    const minutes = Math.round(calculerTempsCharge(kwh, type.puissance_kw));
    const resultat = $("ev-calc-result");
    resultat.classList.remove("hidden");
    const profil = obtenirProfilVehicule();
    resultat.innerHTML =
      `⏱️ Temps de charge estimé : <strong>${formaterMinutes(minutes)}</strong> (à ${escapeHtml(type.puissance_kw)} kW).` +
      `<br>🏠 Coût à domicile : <strong>${euros(kwh * profil.prix_hc_eur_kwh)}</strong> en heures creuses, <strong>${euros(kwh * profil.prix_hp_eur_kwh)}</strong> en heures pleines.` +
      `<br>🔌 Sur une borne publique (~${euros(0.45)}/kWh) : environ <strong>${euros(kwh * 0.45)}</strong>.`;
  });
}

// ── Recherche de bornes ────────────────────────────────────────────────────

function cablerRecherche() {
  const select = $("ev-recherche-operateur-select");
  select.addEventListener("change", () => {
    const autre = select.value === "__autre__";
    $("ev-recherche-operateur-input").classList.toggle("hidden", !autre);
    if (autre) $("ev-recherche-operateur-input").focus();
  });
  $("ev-recherche-rayon-input").addEventListener("input", () => {
    $("ev-recherche-rayon-value").textContent = $("ev-recherche-rayon-input").value;
  });
  $("ev-recherche-gps-btn").addEventListener("click", () => ($("ev-recherche-lieu-input").value = "Ma position"));

  $("ev-recherche-run-btn").addEventListener("click", async () => {
    const operateur = select.value === "__autre__" ? $("ev-recherche-operateur-input").value.trim() : select.value;
    const zone = $("ev-recherche-results");
    zone.innerHTML = hint("Recherche en cours...");
    const btn = $("ev-recherche-run-btn");
    btn.disabled = true;
    try {
      const r = await rechercherBornesAutour($("ev-recherche-lieu-input").value.trim() || "Ma position", {
        operateur,
        type_acces: $("ev-recherche-acces-select").value,
        rayon_km: parseFloat($("ev-recherche-rayon-input").value),
        carte_bancaire_uniquement: $("ev-recherche-cb-checkbox").checked,
      });
      if (!r.ok) {
        zone.innerHTML = `<div class="ev-charge-cout-alerte">Erreur : ${escapeHtml(r.erreur || "inconnue")}</div>`;
        return;
      }
      listeBornes(zone, r.bornes || [], "", `Aucune borne trouvée pour ces critères autour de « ${nomCourt(r.lieu)} ».`);
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Profil véhicule, domicile, clés API ────────────────────────────────────

function majBandeauCles() {
  const { tomtom, openChargeMap } = getApiKeys();
  $("ev-cles-manquantes").classList.toggle("hidden", !!(tomtom && openChargeMap));
}

function rendreProfil() {
  const profil = obtenirProfilVehicule();
  $("ev-vehicule-badge").textContent = profil.nom || "";
  $("ev-profil-nom").value = profil.nom || "";
  $("ev-profil-capacite").value = profil.capacite_kwh;
  $("ev-profil-conso").value = profil.consommation_kwh_100km;
  $("ev-profil-ac").value = profil.puissance_ac_kw;
  $("ev-profil-dc").value = profil.puissance_dc_kw;
  $("ev-profil-connecteurs").value = (profil.connecteurs_acceptes || []).join(", ");
  $("ev-profil-saison").value = profil.saison || "mi_saison";
  $("ev-profil-prix-hc").value = profil.prix_hc_eur_kwh;
  $("ev-profil-prix-hp").value = profil.prix_hp_eur_kwh;
  $("ev-profil-part-hc").value = profil.part_hc_pct;

  const reglages = lireReglages();
  $("ev-reglage-domicile").value = reglages.adresse_domicile || "";
  $("ev-reglage-annonce").checked = !!reglages.annonce_vocale;

  const { tomtom, openChargeMap } = getApiKeys();
  $("ev-cle-tomtom").value = tomtom || "";
  $("ev-cle-ocm").value = openChargeMap || "";

  const types = typesDeCharge(profil);
  for (const option of $("ev-calc-type-select").options) {
    const t = types[option.value];
    if (t) option.textContent = `${t.label} — ${t.puissance_kw} kW`;
  }
}

function basculerProfil(afficher) {
  $("ev-charge-profil-panel").classList.toggle("hidden", !afficher);
  $("ev-charge-form").classList.toggle("hidden", afficher);
  if (afficher) rendreProfil();
  window.scrollTo({ top: 0 });
}

function cablerProfil() {
  $("ev-charge-profil-btn").addEventListener("click", () => basculerProfil($("ev-charge-profil-panel").classList.contains("hidden")));
  $("ev-profil-cancel-btn").addEventListener("click", () => basculerProfil(false));
  $("ev-profil-save-btn").addEventListener("click", () => {
    const connecteurs = $("ev-profil-connecteurs").value.split(",").map((s) => s.trim()).filter(Boolean);
    definirProfilVehicule({
      nom: $("ev-profil-nom").value.trim() || undefined,
      capacite_kwh: nombreOuUndefined($("ev-profil-capacite").value),
      consommation_kwh_100km: nombreOuUndefined($("ev-profil-conso").value),
      puissance_ac_kw: nombreOuUndefined($("ev-profil-ac").value),
      puissance_dc_kw: nombreOuUndefined($("ev-profil-dc").value),
      prix_hc_eur_kwh: nombreOuUndefined($("ev-profil-prix-hc").value),
      prix_hp_eur_kwh: nombreOuUndefined($("ev-profil-prix-hp").value),
      part_hc_pct: nombreOuUndefined($("ev-profil-part-hc").value),
      connecteurs_acceptes: connecteurs.length ? connecteurs : undefined,
      saison: $("ev-profil-saison").value,
    });
    sauverReglages({ adresse_domicile: $("ev-reglage-domicile").value.trim(), annonce_vocale: $("ev-reglage-annonce").checked });
    setApiKeys({ tomtom: $("ev-cle-tomtom").value.trim(), openChargeMap: $("ev-cle-ocm").value.trim() });
    rendreProfil();
    majBandeauCles();
    basculerProfil(false);
    toast("✅ Profil et réglages enregistrés.");
  });
}

// ── Onglets ────────────────────────────────────────────────────────────────

function choisirOnglet(onglet) {
  for (const nom of ["trajet", "calc", "recherche"]) {
    $(`ev-tab-${nom}`).classList.toggle("hidden", nom !== onglet);
    $(`ev-tab-${nom}-btn`).classList.toggle("accent", nom === onglet);
  }
}

// ── Démarrage ──────────────────────────────────────────────────────────────

export function initialiserUI() {
  $("ev-tab-trajet-btn").addEventListener("click", () => choisirOnglet("trajet"));
  $("ev-tab-calc-btn").addEventListener("click", () => choisirOnglet("calc"));
  $("ev-tab-recherche-btn").addEventListener("click", () => choisirOnglet("recherche"));

  $("ev-trajet-run-btn").addEventListener("click", lancerTrajet);
  $("ev-aller-retour-btn").addEventListener("click", lancerAllerRetour);
  $("ev-scenarios-btn").addEventListener("click", lancerScenarios);
  $("ev-destination-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
      lancerTrajet();
    }
  });
  $("ev-depart-gps-btn").addEventListener("click", () => ($("ev-depart-input").value = "Ma position"));

  window.addEventListener("popstate", fermerOverlays);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") fermerOverlayDepuisBouton();
  });

  cablerCurseursEtModes();
  cablerActionsResultat();
  cablerCourbes();
  cablerFrise();
  cablerFicheBorne();
  cablerHistoriqueFavoris();
  cablerUrgence();
  cablerCalculateur();
  cablerRecherche();
  cablerProfil();

  chargerPrefs();
  rendreProfil();
  majBandeauCles();
  choisirOnglet("trajet");
}
