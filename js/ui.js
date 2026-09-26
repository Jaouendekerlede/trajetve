// Interface "carte d'abord" : carte plein écran avec les bornes autour,
// panneau coulissant (liste, fiche borne, trajet, résultat, favoris,
// outils, profil) et barre de navigation. Les calculs viennent du moteur
// local (trajet.js), portage du panneau Trajet VE de JARVIS.

import { getApiKeys, setApiKeys, MODES_TRAJET } from "./config.js";
import { obtenirProfilVehicule, definirProfilVehicule, listerHistoriqueTrajets, supprimerTrajetHistorique, effacerHistoriqueTrajets, listerTrajetsFavoris, ajouterTrajetFavori, retirerTrajetFavori, listerBornesFavorites, estBorneFavorite, basculerFavoriBorne, obtenirNoteBorne, definirNoteBorne, lirePrefs, sauverPrefs, lireReglages, sauverReglages, consoMesuree, appliquerAbonnements } from "./storage.js";
import { planifierTrajet, planifierAlternative, planifierAllerRetour, comparerScenarios, bornesADistance, rechercherBornesAutour, bornesUrgence } from "./trajet.js";
import { diagnostiquerCleTomTom } from "./tomtom.js";

import { typesDeCharge, calculerTempsCharge, exporterTrajetTexte, exporterScenariosTexte, formaterMinutes } from "./planner.js";
import { initCarte, fondSuivant, choisirFond, rechargerFond, activerCarte3D, carte3DActive, fondCourant, derniereErreur3D, ICONES_FONDS, definirDecalageBas, centreVisible, rayonVisibleKm, zoomActuel, centrer, classePuissance, puissanceBorne, afficherBornes, rafraichirBorne, selectionnerBorne, montrerBornes, afficherPosition, afficherTrajet, afficherAlternatives, effacerTrajet, placerCurseur } from "./carte.js";
import { afficherCourbe, detruireCourbe } from "./courbe.js";
import { rechercherBornesZone, borneCompatible } from "./ocm.js";
import { resoudreLieu, haversineKm } from "./geo.js";
import { escapeHtml, lienGoogleMaps, lienWaze, estNuit } from "./util.js";
import { $, toast, euros, nombre, nomCourt, nombreOuUndefined, hint, alerte, tuile, telechargerTexte, badgeOperateur } from "./ui-commun.js";
import { rendreJournal, cablerJournal } from "./ui-journal.js";
import { rendreAbonnements, cablerAbonnements } from "./ui-abonnements.js";
import { exporterSauvegarde, importerSauvegarde, envoyerLienRestauration, majInfoLien } from "./ui-sauvegarde.js";
import { installerAppli, majBoutonInstallation } from "./ui-installation.js";
import { cablerZonesEvitees } from "./ui-zones.js";
import { classeNumero } from "./panneau-nav.js";
import { cablerSuggestions } from "./ui-suggestions.js";
import { cablerVoitureGaree } from "./ui-voiture.js";
import { rendreStats, cablerStats } from "./ui-stats.js";
import { remplirArretsImposes, cablerArretsImposes, arretImposeChoisi } from "./ui-arret-impose.js";
import { boutonQuandPartir, quandPartir } from "./ui-quand-partir.js";
import { reconnaissanceDispo, ecouter, interpreterCommande } from "./commandes-vocales.js";
import { cablerParkings, planifierParkings, cablerTrafic } from "./ui-parkings.js";
import { afficherAccueil } from "./ui-accueil.js";
import { estimerPreparation, preparerHorsLigne } from "./hors-ligne.js";
import { enrichirBornes, stationsOfficiellesZone, fusionnerBornes } from "./irve.js";
import { demarrerNavigation, navigationActive, retourNavigationEnCours, traceRestante, navigationInterrompue, oublierNavigationInterrompue } from "./navigation.js";

const VUES = ["bornes", "borne", "trajet", "resultat", "favoris", "outils", "profil"];
const ETAT_FEUILLE_PAR_VUE = { bornes: "bas", borne: "mi", trajet: "haut", resultat: "mi", favoris: "haut", outils: "haut", profil: "haut" };
const ONGLET_PAR_VUE = { bornes: "bornes", trajet: "trajet", resultat: "trajet", favoris: "favoris", outils: "outils", profil: "profil" };
const LABELS_MODE = { rapide: "⚡ Rapide", economique: "💶 Économique", confort: "🛋️ Confort", prudent: "🛡️ Prudent" };
const BOUTONS_CALCUL = ["ev-trajet-run-btn", "ev-aller-retour-btn", "ev-scenarios-btn"];
const HAUTEUR_REPLIEE = 172;

let vueCourante = "bornes";
let vueAvantBorne = "bornes";
let etatFeuille = "bas";
let modeTrajet = "confort";
// Suit si marge/objectif ont été touchés à la main APRÈS le choix d'un mode :
// sans ça, recliquer sur un mode écraserait ces réglages sans prévenir.
let slidersModifiesManuellement = false;
let dernierTrajet = null;
let trajetAffiche = false;
let dernierChargeDepartPct = 80;
let dernierScenarios = null;
// Routes proposées pour le dernier trajet : plans[0] = la plus rapide,
// les suivantes = alternatives TomTom dont le plan de recharge est calculé
// en arrière-plan (null en attendant). routes[i] (tracé, distance, durée)
// permet de les montrer avant la fin de ce calcul.
let itineraires = { jeton: 0, plans: [], routes: [] };
let dernieresOptions = null;
let borneOuverte = null;
let calculEnCours = false;
let bornesZone = [];
let derniereZone = null;
let rechercheManuelle = null;
let zoneIncomplete = false;
let jetonZone = 0;
let minuteurDeplacement = null;
const filtres = new Set();
const listesAffichees = new Map();

// ── Petits utilitaires ─────────────────────────────────────────────────────

function setSlider(prefixe, valeur) {
  $(`${prefixe}-input`).value = String(valeur);
  $(`${prefixe}-value`).textContent = String(valeur);
}

function dateFr(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeHtml(iso) : d.toLocaleDateString("fr-FR");
}

function heure(ms) {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function classeBatterie(pct) {
  return pct >= 50 ? "good" : pct >= 20 ? "warn" : "bad";
}

function batterieHtml(pct) {
  return `<span class="ev-batt ${classeBatterie(pct)}">🔋 ${nombre(pct, pct % 1 ? 1 : 0)} %</span>`;
}

function ecranLarge() {
  return window.matchMedia("(min-width: 900px)").matches;
}

// ── Panneau coulissant ─────────────────────────────────────────────────────

function positionsFeuille() {
  const h = $("ev-feuille").offsetHeight;
  return { haut: 0, mi: Math.max(0, h - Math.round(window.innerHeight * 0.5)), bas: Math.max(0, h - HAUTEUR_REPLIEE) };
}

function appliquerPosition(y, anime) {
  const feuille = $("ev-feuille");
  const nav = document.querySelector(".ev-nav").offsetHeight;
  if (ecranLarge()) {
    feuille.style.transform = "";
    $("ev-feuille-corps").style.paddingBottom = "";
    document.documentElement.style.setProperty("--feuille-visible", "0px");
    definirDecalageBas(0);
    return;
  }
  feuille.style.transition = anime ? "" : "none";
  feuille.style.transform = `translateY(${y}px)`;
  $("ev-feuille-corps").style.paddingBottom = `${y + 24}px`;
  const visible = feuille.offsetHeight - y + nav;
  document.documentElement.style.setProperty("--feuille-visible", `${visible}px`);
  definirDecalageBas(visible);
}

function definirFeuille(etat) {
  etatFeuille = etat;
  document.body.dataset.feuille = etat;
  appliquerPosition(positionsFeuille()[etat], true);
}

function cablerFeuille() {
  const poignee = $("ev-poignee");
  const zones = [poignee, ...document.querySelectorAll(".ev-vue-entete")];
  let debutY = null;
  let debutPos = 0;
  let pos = 0;
  let t0 = 0;
  let deplace = false;
  let zoneActive = null;

  const debut = (e) => {
    if (ecranLarge()) return;
    debutY = e.clientY;
    debutPos = positionsFeuille()[etatFeuille];
    pos = debutPos;
    t0 = Date.now();
    deplace = false;
    zoneActive = e.currentTarget;
  };
  const bouger = (e) => {
    if (debutY === null) return;
    const dy = e.clientY - debutY;
    if (!deplace && Math.abs(dy) > 8) {
      deplace = true;
      try {
        zoneActive.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (!deplace) return;
    pos = Math.max(0, Math.min(positionsFeuille().bas, debutPos + dy));
    appliquerPosition(pos, false);
  };
  const fin = (e) => {
    if (debutY === null) return;
    const dy = e.clientY - debutY;
    const vitesse = dy / Math.max(1, Date.now() - t0);
    debutY = null;
    if (!deplace) {
      if (zoneActive === poignee) definirFeuille(etatFeuille === "bas" ? "mi" : etatFeuille === "mi" ? "haut" : "mi");
      return;
    }
    const p = positionsFeuille();
    let cible;
    if (vitesse < -0.5) cible = pos <= p.mi ? "haut" : "mi";
    else if (vitesse > 0.5) cible = pos >= p.mi ? "bas" : "mi";
    else cible = ["haut", "mi", "bas"].reduce((a, b) => (Math.abs(p[b] - pos) < Math.abs(p[a] - pos) ? b : a));
    definirFeuille(cible);
  };
  for (const z of zones) {
    z.addEventListener("pointerdown", debut);
    z.addEventListener("pointermove", bouger);
    z.addEventListener("pointerup", fin);
    z.addEventListener("pointercancel", fin);
  }
  window.addEventListener("resize", () => definirFeuille(etatFeuille));
}

// ── Navigation entre les vues ──────────────────────────────────────────────

function afficherVue(vue, { etat, historique = true } = {}) {
  if (vue === "borne" && vueCourante !== "borne") vueAvantBorne = vueCourante;
  for (const v of VUES) $(`vue-${v}`).classList.toggle("hidden", v !== vue);
  vueCourante = vue;
  if (vue === "trajet") remplirArretsImposes();
  if (vue === "outils") {
    rendreJournal();
    rendreStats();
  }
  // Mesures et abonnements ont pu changer depuis (navigation, autre écran).
  if (vue === "profil") {
    majConsoMesuree();
    rendreAbonnements();
  }
  const onglet = ONGLET_PAR_VUE[vue];
  if (onglet) document.querySelectorAll(".ev-nav-btn").forEach((b) => b.classList.toggle("actif", b.dataset.vue === onglet));
  $("ev-feuille-corps").scrollTop = 0;
  definirFeuille(etat || ETAT_FEUILLE_PAR_VUE[vue]);
  const contexteTrajet = vue === "resultat" || (vue === "borne" && vueAvantBorne === "resultat");
  montrerBornes(!contexteTrajet);

  // Le bouton "retour" d'Android revient en arrière dans l'appli au lieu de la quitter.
  if (historique && vue !== "bornes") {
    if (vue === "borne" || !history.state?.vue) history.pushState({ vue }, "");
    else history.replaceState({ vue }, "");
  }
}

function revenirDeBorne() {
  selectionnerBorne(null);
  borneOuverte = null;
  afficherVue(vueAvantBorne === "borne" ? "bornes" : vueAvantBorne, { historique: false });
}

function cablerNavigation() {
  document.querySelectorAll(".ev-nav-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const cible = btn.dataset.vue;
      if (cible === "trajet" && trajetAffiche && vueCourante !== "resultat") afficherVue("resultat");
      else if (cible === "bornes") afficherVue("bornes", { etat: vueCourante === "bornes" ? (etatFeuille === "bas" ? "mi" : "bas") : "bas", historique: false });
      else afficherVue(cible);
      if (cible === "favoris") renderFavoris();
    }),
  );
  $("ev-borne-retour").addEventListener("click", () => {
    if (history.state?.vue === "borne") history.back();
    else revenirDeBorne();
  });
  window.addEventListener("popstate", () => {
    if (navigationActive() || retourNavigationEnCours()) return;
    if (!$("ev-urgence-panel").classList.contains("hidden")) {
      $("ev-urgence-panel").classList.add("hidden");
      return;
    }
    if (vueCourante === "borne") revenirDeBorne();
    else if (vueCourante !== "bornes") afficherVue("bornes", { historique: false });
  });
  $("ev-recherche-rapide").addEventListener("click", () => {
    afficherVue("trajet");
    setTimeout(() => $("ev-destination-input").focus(), 320);
  });
}

// ── Paiement : état "carte bancaire" toujours sourcé ───────────────────────

const OUI_NON = { oui: "✅ oui", partiel: "⚠️ sur une partie des points", non: "❌ non" };

function officielValide(b) {
  return b.officiel && !b.officiel.indisponible ? b.officiel : null;
}

function etatCb(b) {
  const o = officielValide(b);
  if (o) {
    if (o.paiement_cb === "oui") return { classe: "ok", court: "💳 CB acceptée", long: "✅ Acceptée" };
    if (o.paiement_cb === "partiel") return { classe: "warn", court: "💳 CB sur certains points", long: "⚠️ Sur une partie des points seulement" };
    return { classe: "non", court: "🚫 Pas de CB", long: "❌ Non acceptée" };
  }
  if (b.officiel === undefined) return { classe: "attente", court: "💳 vérification…", long: "Vérification en cours…" };
  if (b.paiement_cb_probable) return { classe: "inconnu", court: "💳 CB probable", long: "❓ Non confirmé — probable : borne ≥50 kW, terminal CB obligatoire sur les bornes neuves depuis 04/2024" };
  return { classe: "inconnu", court: "💳 CB non renseignée", long: "❓ Non renseigné" };
}

function prixConnu(b) {
  if (b.prix_kwh_eur == null || b.prix_est_estimation) return null;
  return b.prix_kwh_eur;
}

function prixRetenuHtml(b) {
  if (b.prix_kwh_eur == null) return "";
  const source =
    b.prix_source === "abonnement"
      ? `ton abonnement ${b.abonnement}`
      : b.prix_source === "officiel"
        ? "tarif officiel déclaré"
        : b.prix_est_estimation
          ? "estimation par défaut, tarif réel non communiqué"
          : "tarif Open Charge Map";
  return `${euros(b.prix_kwh_eur)}/kWh (${source})`;
}

function coutHtml(coutEstime, prixKwh, estimation) {
  if (coutEstime !== undefined && coutEstime !== null) {
    return `💶 ${estimation ? "~" : ""}${euros(coutEstime)}${estimation ? " (estimé, tarif non communiqué)" : ""}`;
  }
  if (prixKwh !== undefined && prixKwh !== null) return `💶 ~${euros(prixKwh)}/kWh${estimation ? " (estimé)" : ""}`;
  return "";
}

// État déclaré par l'opérateur : hors service (avec la date du signalement)
// ou, si l'information a moins d'une heure, points libres.
function pastilleEtat(etat) {
  if (!etat) return "";
  const date = etat.date_signalement ? ` (${new Date(etat.date_signalement).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })})` : "";
  if (etat.tous_hors_service) return `<span class="ev-cb-pill non">🔴 Hors service${date}</span>`;
  if (etat.hors_service) return `<span class="ev-cb-pill warn">⚠️ ${etat.hors_service}/${etat.total} hors service${date}</span>`;
  if (etat.libres) return `<span class="ev-cb-pill ok">🟢 ${etat.libres} libre${etat.libres > 1 ? "s" : ""} (< 1 h)</span>`;
  if (etat.occupes) return `<span class="ev-cb-pill warn">🟠 Occupée (< 1 h)</span>`;
  return "";
}

function pastillesBorne(b) {
  const o = officielValide(b);
  const cb = etatCb(b);
  const morceaux = [pastilleEtat(b.etat_dynamique), `<span class="ev-cb-pill ${cb.classe}">${cb.court}</span>`].filter(Boolean);
  const prix = prixConnu(b);
  if (o?.gratuit === "oui") morceaux.push(`<span class="ev-cb-pill ok">🎁 Gratuit</span>`);
  else if (prix !== null) morceaux.push(`<span class="ev-cb-pill ${b.abonnement ? "ok" : "neutre"}">${b.abonnement ? "💳" : "💶"} ${euros(prix)}/kWh${b.abonnement ? " (abonnement)" : ""}</span>`);
  if (o && /24\s*\/\s*7|24\s*h/i.test(o.horaires)) morceaux.push(`<span class="ev-cb-pill neutre">🕐 24h/24</span>`);
  return morceaux.join("");
}

// ── Liste de bornes ────────────────────────────────────────────────────────

function ligneBorneHtml(b, i, suffixeDistance = "") {
  const kw = puissanceBorne(b);
  const o = officielValide(b);
  const points = o?.nombre_points || b.nombre_points;
  const operateur = b.operateur || o?.operateur;
  const sous = [operateur || "Opérateur inconnu", b.distance_km != null ? `${nombre(b.distance_km, 1)} km${suffixeDistance}` : "", points ? `${points} pts` : ""]
    .filter(Boolean)
    .join(" · ");
  return `
    <button type="button" class="ev-borne-ligne" data-idx="${i}">
      <div class="ev-borne-puissance ${classePuissance(kw)}">${kw || "?"}<small>kW</small></div>
      <div class="ev-borne-infos">
        <div class="ev-borne-nom">${escapeHtml(b.nom || b.nom_borne || "Borne de recharge")}</div>
        <div class="ev-borne-sous">${badgeOperateur(operateur)}${escapeHtml(sous)}</div>
        <div class="ev-borne-pastilles">${pastillesBorne(b)}</div>
      </div>
    </button>`;
}

function afficherListe(conteneur, bornes, messageVide, suffixeDistance = "") {
  listesAffichees.set(conteneur.id, bornes);
  conteneur.innerHTML = bornes.map((b, i) => ligneBorneHtml(b, i, suffixeDistance)).join("") || hint(messageVide);
}

function cablerListe(conteneur, action) {
  conteneur.addEventListener("click", (e) => {
    const ligne = e.target.closest("[data-idx]");
    if (!ligne) return;
    const b = listesAffichees.get(conteneur.id)?.[Number(ligne.dataset.idx)];
    if (b) action(b);
  });
}

// ── Bornes autour de la carte ──────────────────────────────────────────────

function cbPossible(b) {
  const o = officielValide(b);
  if (o) return o.paiement_cb !== "non";
  if (b.officiel === undefined) return true;
  return !!b.paiement_cb_probable;
}

function passeFiltres(b) {
  const o = officielValide(b);
  const enAttente = b.officiel === undefined;
  if (filtres.has("rapide") && puissanceBorne(b) < 50) return false;
  if (filtres.has("cb") && !cbPossible(b)) return false;
  if (filtres.has("compatible") && !borneCompatible(b, obtenirProfilVehicule().connecteurs_acceptes)) return false;
  if (filtres.has("h24") && !enAttente && !(o && /24\s*\/\s*7|24\s*h/i.test(o.horaires))) return false;
  if (filtres.has("gratuit") && !enAttente && !(o?.gratuit === "oui" || /gratuit|free/i.test(b.cout_texte || ""))) return false;
  return true;
}

function renderBornes({ carteAussi = true } = {}) {
  const liste = bornesZone.filter(passeFiltres);
  if (carteAussi) afficherBornes(liste, (b) => ouvrirBorne(b, { centrerCarte: false }));
  const nbFiltres = filtres.size ? ` · ${filtres.size} filtre${filtres.size > 1 ? "s" : ""}` : "";
  $("ev-bornes-titre").textContent = rechercheManuelle
    ? `🔍 ${liste.length} borne${liste.length > 1 ? "s" : ""} — ${rechercheManuelle}`
    : `📍 ${liste.length} borne${liste.length > 1 ? "s" : ""} à proximité${nbFiltres}`;
  $("ev-recherche-effacer").classList.toggle("hidden", !rechercheManuelle);
  afficherListe(
    $("ev-bornes-liste"),
    liste,
    bornesZone.length ? "Aucune borne ne correspond aux filtres choisis." : "Aucune borne trouvée dans cette zone. Déplace ou dézoome la carte.",
  );
  if (zoneIncomplete && !rechercheManuelle) {
    $("ev-bornes-liste").insertAdjacentHTML("afterbegin", hint("Beaucoup de bornes ici : seules les plus proches du centre de la carte sont affichées. Zoome pour voir les autres."));
  }
}

async function enrichirProgressivement(bornes, toujoursValide) {
  for (let k = 0; k < bornes.length; k += 6) {
    const groupe = bornes.slice(k, k + 6);
    appliquerAbonnements(await enrichirBornes(groupe));
    if (!toujoursValide()) return;
    if (filtres.size) renderBornes();
    else {
      groupe.forEach(rafraichirBorne);
      renderBornes({ carteAussi: false });
    }
  }
}

async function chargerBornesZone(force = false) {
  const { openChargeMap } = getApiKeys();
  const rayon = rayonVisibleKm();
  if (rayon > 60) {
    jetonZone++;
    bornesZone = [];
    derniereZone = null;
    renderBornes();
    $("ev-bornes-titre").textContent = "🔎 Zoome sur la carte pour voir les bornes";
    return;
  }
  const c = centreVisible();
  const r = Math.max(1.5, Math.min(40, rayon));
  if (
    !force &&
    derniereZone &&
    haversineKm(c.lat, c.lon, derniereZone.lat, derniereZone.lon) < derniereZone.rayon * 0.3 &&
    r <= derniereZone.rayon * 1.25 &&
    r >= derniereZone.rayon * 0.5
  ) {
    return;
  }
  const jeton = ++jetonZone;
  $("ev-bornes-titre").textContent = "⏳ Recherche des bornes…";
  // Deux sources : Open Charge Map (collaborative, monde entier) et la base
  // officielle française (plus complète en France, avec le paiement CB).
  const [res, officielles] = await Promise.all([
    openChargeMap ? rechercherBornesZone(openChargeMap, c.lat, c.lon, { rayonKm: r, maxResultats: 80 }) : Promise.resolve({ ok: false, erreur: "cle_manquante", bornes: [] }),
    stationsOfficiellesZone(c.lat, c.lon, r, { maxLignes: 450 }),
  ]);
  if (jeton !== jetonZone) return;
  if (!res.ok && !officielles.bornes.length) {
    $("ev-bornes-titre").textContent = "📍 Bornes à proximité";
    $("ev-bornes-liste").innerHTML = alerte(
      res.erreur === "cle_manquante" ? "Clé Open Charge Map manquante ou refusée : vérifie-la dans 🚗 Profil." : `Recherche de bornes indisponible (${res.erreur}).`,
    );
    return;
  }
  derniereZone = { lat: c.lat, lon: c.lon, rayon: r };
  bornesZone = fusionnerBornes(res.ok ? res.bornes : [], officielles.bornes);
  zoneIncomplete = !!officielles.incomplet;
  renderBornes();
  enrichirProgressivement(
    bornesZone.filter((b) => b.officiel === undefined),
    () => jeton === jetonZone,
  );
}

function surDeplacementCarte() {
  // Parkings : aussi sur l'écran du trajet (se garer à l'arrivée).
  planifierParkings();
  const contexteTrajet = vueCourante === "resultat" || (vueCourante === "borne" && vueAvantBorne === "resultat");
  if (rechercheManuelle || contexteTrajet || navigationActive()) return;
  clearTimeout(minuteurDeplacement);
  minuteurDeplacement = setTimeout(() => chargerBornesZone(), 650);
}

// ── Thème clair / sombre ───────────────────────────────────────────────────

function themeResolu(choix) {
  if (choix === "auto") return window.matchMedia("(prefers-color-scheme: light)").matches ? "clair" : "sombre";
  return choix === "clair" ? "clair" : "sombre";
}

function fondParDefaut() {
  return document.documentElement.dataset.theme === "clair" ? "plan" : "sombre";
}

function appliquerTheme() {
  const reglages = lireReglages();
  const choix = reglages.theme || "sombre";
  const theme = themeResolu(choix);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "clair" ? "#ffffff" : "#05080e");
  document.querySelectorAll("[data-theme-choix]").forEach((b) => b.classList.toggle("active", b.dataset.themeChoix === choix));
  // Tant que l'utilisateur n'a pas choisi de fond de carte, il suit le thème.
  if (!reglages.fond_carte) $("ev-fond-btn").textContent = ICONES_FONDS[choisirFond(fondParDefaut())];
  if (dernierTrajet && !$("ev-profil-trajet").classList.contains("hidden")) afficherVueCourbe();
}

function cablerTheme() {
  document.querySelectorAll("[data-theme-choix]").forEach((b) =>
    b.addEventListener("click", () => {
      sauverReglages({ theme: b.dataset.themeChoix });
      appliquerTheme();
    }),
  );
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (lireReglages().theme === "auto") appliquerTheme();
  });
}

// Carte nuit au coucher du soleil, jour au lever (à l'endroit regardé).
// Seulement au moment du basculement : un choix manuel du fond reste
// respecté jusqu'au prochain lever ou coucher. Le satellite n'est pas touché.
let etaitNuit = null;
function appliquerJourNuit(auDemarrage = false) {
  if (lireReglages().jour_nuit_auto === false) return;
  const c = centreVisible();
  const nuit = estNuit(c.lat, c.lon);
  if (!auDemarrage && nuit === etaitNuit) return;
  etaitNuit = nuit;
  const actuel = fondCourant();
  const voulu = nuit ? "sombre" : "plan";
  if (actuel === "satellite" || actuel === voulu) return;
  $("ev-fond-btn").textContent = ICONES_FONDS[choisirFond(voulu)];
  if (!auDemarrage) toast(nuit ? "🌙 Coucher du soleil : carte de nuit" : "☀️ Lever du soleil : carte de jour");
}

function majBoutonCarte3D() {
  const actif = carte3DActive();
  $("ev-carte3d-btn").classList.toggle("actif", actif);
  $("ev-carte3d-btn").textContent = actif ? "2D" : "3D";
  $("ev-carte3d-btn").title = actif ? "Revenir à la carte à plat (2D)" : "Voir la carte en 3D (inclinée, bâtiments en relief)";
}

// parUtilisateur : choix mémorisé et message ; sinon (démarrage), silencieux.
async function basculerCarte3D(actif, parUtilisateur) {
  const bouton = $("ev-carte3d-btn");
  if (bouton.disabled) return;
  bouton.disabled = true;
  if (actif) bouton.textContent = "…";
  try {
    const ok = await activerCarte3D(actif);
    if (parUtilisateur) {
      if (ok) sauverReglages({ carte_explo_3d: actif });
      toast(ok ? (actif ? "🏙️ Carte en 3D : deux doigts pour tourner ou incliner" : "🗺️ Carte à plat") : `⚠️ 3D indisponible : ${derniereErreur3D() || "raison inconnue"}`);
    }
  } finally {
    bouton.disabled = false;
    majBoutonCarte3D();
  }
}

function cablerCarte() {
  const reglages = lireReglages();
  const fond = choisirFond(reglages.fond_carte || fondParDefaut());
  $("ev-fond-btn").textContent = ICONES_FONDS[fond];
  $("ev-fond-btn").addEventListener("click", () => {
    const nom = fondSuivant();
    $("ev-fond-btn").textContent = ICONES_FONDS[nom];
    sauverReglages({ fond_carte: nom });
    toast({ sombre: "🌙 Carte sombre", plan: "🗺️ Plan clair", satellite: "🛰️ Vue satellite" }[nom]);
  });

  appliquerJourNuit(true);
  setInterval(appliquerJourNuit, 60000);

  $("ev-carte3d-btn").addEventListener("click", () => basculerCarte3D(!carte3DActive(), true));
  document.addEventListener("carte3d-panne", (e) => {
    majBoutonCarte3D();
    toast(`⚠️ Carte 3D interrompue (${e.detail}) : retour en 2D`);
  });
  if (reglages.carte_explo_3d) basculerCarte3D(true, false);

  for (const f of reglages.filtres_carte || []) filtres.add(f);
  cablerParkings();
  cablerTrafic();
  cablerVoitureGaree();
  cablerStats();
  cablerArretsImposes();
  cablerSuggestions(["ev-depart-input", "ev-destination-input"]);
  // 🎤 Dicter la destination : « Nantes », « aller à la gare de Rennes »…
  $("ev-destination-micro").addEventListener("click", async () => {
    if (!reconnaissanceDispo()) return toast("🎤 Dictée indisponible sur ce navigateur");
    toast("🎤 Dites votre destination…");
    const texte = await ecouter();
    if (!texte) return toast("🎤 Je n'ai pas compris");
    const c = interpreterCommande(texte);
    $("ev-destination-input").value = c.action === "aller" ? c.lieu : texte;
    lancerTrajet();
  });

  document.querySelectorAll(".ev-chip[data-filtre]").forEach((chip) => {
    chip.classList.toggle("actif", filtres.has(chip.dataset.filtre));
    chip.addEventListener("click", () => {
      const f = chip.dataset.filtre;
      if (filtres.has(f)) filtres.delete(f);
      else filtres.add(f);
      chip.classList.toggle("actif", filtres.has(f));
      sauverReglages({ filtres_carte: [...filtres] });
      renderBornes();
      if (vueCourante !== "bornes" && vueCourante !== "resultat") afficherVue("bornes", { etat: "mi", historique: false });
    });
  });

  $("ev-localiser-btn").addEventListener("click", localiser);
  $("ev-recherche-effacer").addEventListener("click", () => {
    rechercheManuelle = null;
    derniereZone = null;
    chargerBornesZone(true);
  });
  cablerListe($("ev-bornes-liste"), (b) => ouvrirBorne(b));
}

async function localiser() {
  toast("📍 Recherche de ta position…");
  const pos = await resoudreLieu("ma position");
  if (pos.erreur) {
    toast(pos.erreur);
    return false;
  }
  afficherPosition(pos.lat, pos.lon);
  centrer(pos.lat, pos.lon, Math.max(zoomActuel(), 13.5));
  return true;
}

async function positionDeDepart() {
  const pos = await resoudreLieu("ma position");
  if (!pos.erreur) {
    afficherPosition(pos.lat, pos.lon);
    centrer(pos.lat, pos.lon, 13.5);
    return;
  }
  const domicile = lireReglages().adresse_domicile;
  if (domicile) {
    const lieu = await resoudreLieu("chez moi", domicile);
    if (!lieu.erreur) {
      centrer(lieu.lat, lieu.lon, 13);
      return;
    }
  }
  chargerBornesZone(true);
}

// ── Fiche borne ────────────────────────────────────────────────────────────

function ligneInfo(label, valeurHtml) {
  return valeurHtml ? `<div class="ev-ligne-info"><span class="label">${label}</span><span class="value">${valeurHtml}</span></div>` : "";
}

function prisesHtml(b) {
  const o = officielValide(b);
  let prises = [];
  if (o?.prises?.length) {
    prises = o.prises.map((p) => ({ nom: p.libelle, kw: p.puissance_max_kw, nb: p.nombre }));
  } else {
    const groupes = new Map();
    for (const c of b.connecteurs || []) {
      const cle = `${c.type}|${c.puissance_kw}`;
      const g = groupes.get(cle) || { nom: c.type, kw: c.puissance_kw, nb: 0 };
      g.nb += c.quantite || 1;
      groupes.set(cle, g);
    }
    prises = [...groupes.values()].sort((a, z) => z.kw - a.kw);
  }
  if (!prises.length) return "";
  return `<div class="ev-prises">${prises
    .map((p) => `<div class="ev-prise"><span class="ev-prise-kw">${p.kw ? `${escapeHtml(p.kw)} kW` : "? kW"}</span><strong>${escapeHtml(p.nom)}</strong><span>${p.nb} point${p.nb > 1 ? "s" : ""}</span></div>`)
    .join("")}</div>`;
}

function ficheBorneHtml(b, ctx) {
  const o = officielValide(b);
  const kw = puissanceBorne(b);
  const cb = etatCb(b);
  const nom = b.nom_borne || b.nom || o?.nom_station || "Borne de recharge";
  const favori = estBorneFavorite(nom, b.lat, b.lon);
  const statutOk = (b.statut || "").toLowerCase().includes("operational");
  const points = o?.nombre_points || b.nombre_points;

  let html = `
    <div class="ev-fiche-tete">
      <div class="ev-borne-puissance ${classePuissance(kw)}">${kw || "?"}<small>kW max</small></div>
      <div>
        <div class="ev-fiche-titre">${escapeHtml(nom)}</div>
        <div class="ev-fiche-sous">${badgeOperateur(b.operateur || o?.operateur)}${escapeHtml([b.operateur || o?.operateur, b.adresse || o?.adresse].filter(Boolean).join(" · "))}</div>
      </div>
    </div>
    <div class="ev-badges">
      ${pastilleEtat(b.etat_dynamique)}
      <span class="ev-cb-pill ${cb.classe}">${cb.court}</span>
      ${points ? `<span class="ev-cb-pill neutre">🔌 ${escapeHtml(points)} point${points > 1 ? "s" : ""}</span>` : ""}
      ${o?.horaires ? `<span class="ev-cb-pill neutre">🕐 ${escapeHtml(o.horaires)}</span>` : ""}
      ${b.statut ? `<span class="ev-cb-pill ${statutOk ? "ok" : "warn"}">${statutOk ? "✅ En service (déclaré)" : `⚠️ ${escapeHtml(b.statut)}`}</span>` : ""}
      ${o?.gratuit === "oui" ? `<span class="ev-cb-pill ok">🎁 Gratuit</span>` : ""}
    </div>
    <div class="ev-actions-rangee">
      <a class="ev-action" href="${lienGoogleMaps(b.lat, b.lon)}" target="_blank" rel="noopener"><span>🧭</span>Y aller</a>
      <a class="ev-action" href="${lienWaze(b.lat, b.lon)}" target="_blank" rel="noopener"><span>🚗</span>Waze</a>
      <button id="ev-borne-fav-btn" class="ev-action${favori ? " actif" : ""}" type="button"><span>${favori ? "★" : "☆"}</span>${favori ? "Favorite" : "Favori"}</button>
      ${
        o?.telephone
          ? `<a class="ev-action" href="${escapeHtml(o.telephone.lien)}"><span>📞</span>Assistance</a>`
          : `<button id="ev-borne-partager-btn" class="ev-action" type="button"><span>📤</span>Partager</button>`
      }
    </div>`;

  if (ctx) {
    html += `<div class="ev-carte-bloc"><h3>🔋 Cet arrêt dans ton trajet</h3>
      <div class="ev-meta"><span>km ${escapeHtml(ctx.km_depuis_depart)}</span><span>⚡ ${escapeHtml(ctx.puissance_kw)} kW</span><span>+${escapeHtml(ctx.kwh_ajoutes)} kWh</span><span>⏱️ ${escapeHtml(ctx.temps_charge_min)} min</span></div>
      <div>${batterieHtml(ctx.pct_arrivee_borne)} → ${batterieHtml(ctx.pct_depart_borne)}</div>
      ${ctx.cout_estime_eur != null ? `<div>${coutHtml(ctx.cout_estime_eur, ctx.prix_kwh_eur, ctx.prix_est_estimation)}</div>` : ""}
      ${ctx.distance_borne_km != null ? `<div class="ev-hint">À ${escapeHtml(ctx.distance_borne_km)} km du tracé.</div>` : ""}`;
    if (typeof ctx.score === "number") {
      const c = ctx.score >= 70 ? "" : ctx.score >= 40 ? "warn" : "bad";
      html += `<div><span class="ev-score ${c}">Recommandation ${ctx.score}/100</span></div>
        <div class="ev-details-score">${(ctx.score_details || []).map((d) => `<span>${d.points >= 0 ? "+" : ""}${d.points} ${escapeHtml(d.label)}</span>`).join("")}</div>`;
    }
    if (ctx.alternatives?.length) {
      html += `<h3>🔁 Plan B à proximité</h3>`;
      ctx.alternatives.forEach((alt, i) => {
        const cbAlt = etatCb(alt);
        html += `<div class="ev-alternative" data-alt="${i}">
          <strong>${escapeHtml(alt.nom)}</strong>
          <div class="ev-meta"><span>${escapeHtml(alt.operateur || "opérateur ?")}</span><span>${escapeHtml(alt.distance_km)} km</span><span>${escapeHtml(alt.puissance_max_kw)} kW</span><span>score ${alt.score}/100</span><span class="ev-cb-pill ${cbAlt.classe}">${cbAlt.court}</span></div>
        </div>`;
      });
    }
    html += `</div>`;
  }

  const prises = prisesHtml(b);
  if (prises) html += `<div class="ev-carte-bloc"><h3>🔌 Prises</h3>${prises}${o?.cable_attache === "oui" ? hint("Câble Type 2 attaché à la borne.") : ""}</div>`;

  let paiement = ligneInfo("Carte bancaire", `<strong class="ev-cb-texte ${cb.classe}">${escapeHtml(cb.long)}</strong>`);
  if (o) {
    paiement += ligneInfo("Sans abonnement (à l'acte)", OUI_NON[o.paiement_acte]);
    paiement += ligneInfo("Badge, appli, abonnement", OUI_NON[o.paiement_autre]);
    paiement += ligneInfo("Recharge gratuite", OUI_NON[o.gratuit]);
    paiement += ligneInfo("Tarif officiel", o.tarifs.length ? escapeHtml(o.tarifs.join(" · ")) : "Non communiqué");
  }
  if (b.cout_texte && b.source !== "irve") paiement += ligneInfo("Tarif Open Charge Map", escapeHtml(b.cout_texte));
  paiement += ligneInfo("Prix utilisé pour les calculs", prixRetenuHtml(b));
  html += `<div class="ev-carte-bloc"><h3>💳 Paiement et tarifs</h3><div>${paiement}</div></div>`;

  if (o) {
    const acces =
      ligneInfo("Conditions d'accès", escapeHtml(o.condition_acces)) +
      ligneInfo("Horaires", escapeHtml(o.horaires)) +
      ligneInfo("Réservation possible", OUI_NON[o.reservation]) +
      ligneInfo("Accessibilité PMR", escapeHtml(o.accessibilite_pmr)) +
      ligneInfo("Restriction de gabarit", escapeHtml(o.restriction_gabarit)) +
      ligneInfo("Emplacement", escapeHtml(o.implantation)) +
      ligneInfo("Adresse déclarée", escapeHtml(o.adresse));
    html += `<div class="ev-carte-bloc"><h3>🕐 Accès</h3><div>${acces}</div></div>`;

    const contact = o.contact ? (o.contact.includes("@") ? `<a href="mailto:${escapeHtml(o.contact)}">${escapeHtml(o.contact)}</a>` : escapeHtml(o.contact)) : "";
    const operateur =
      ligneInfo("Opérateur", escapeHtml(o.operateur)) +
      (o.enseigne && o.enseigne !== o.operateur ? ligneInfo("Enseigne", escapeHtml(o.enseigne)) : "") +
      (o.amenageur && o.amenageur !== o.operateur ? ligneInfo("Propriétaire", escapeHtml(o.amenageur)) : "") +
      (o.telephone ? ligneInfo("Assistance", `<a href="${escapeHtml(o.telephone.lien)}">${escapeHtml(o.telephone.affichage)}</a>`) : "") +
      ligneInfo("Contact", contact) +
      ligneInfo("Remarques", escapeHtml(o.observations)) +
      (o.date_mise_en_service ? ligneInfo("Mise en service", dateFr(o.date_mise_en_service)) : "") +
      (o.date_maj ? ligneInfo("Mise à jour officielle", dateFr(o.date_maj)) : "");
    html += `<div class="ev-carte-bloc"><h3>🏢 Opérateur</h3><div>${operateur}</div></div>`;
    html += hint(
      `Source : Base nationale officielle des bornes (IRVE, data.gouv.fr), déclarée par l'opérateur — station « ${o.nom_station || o.id_station} » à ${o.distance_m} m.` +
        (o.points_consultes < o.nombre_points ? ` Détail établi sur ${o.points_consultes} des ${o.nombre_points} points.` : ""),
    );
  } else if (b.officiel === undefined) {
    html += hint("🔎 Recherche des informations officielles (paiement CB, tarifs, horaires, accès)…");
  } else if (b.officiel?.indisponible) {
    html += hint("Base officielle des bornes momentanément injoignable : réessaie plus tard.");
  } else {
    html += hint("Aucune déclaration officielle trouvée à moins de 150 m (borne hors de France, très récente ou non déclarée) : informations Open Charge Map uniquement.");
  }
  if (b.fraicheur) html += hint(`Open Charge Map : ${b.fraicheur.label}. Occupation en temps réel non disponible.`);
  return html;
}

function remplirFiche(b, ctx) {
  const contenu = $("ev-borne-contenu");
  contenu.innerHTML = ficheBorneHtml(b, ctx);
  contenu.querySelectorAll(".ev-alternative").forEach((el) =>
    el.addEventListener("click", () => ouvrirBorne(ctx.alternatives[Number(el.dataset.alt)], { remplacer: true })),
  );
  const nom = b.nom_borne || b.nom || officielValide(b)?.nom_station || "Borne de recharge";
  $("ev-borne-fav-btn")?.addEventListener("click", () => {
    basculerFavoriBorne(nom, b.lat, b.lon, b.adresse || officielValide(b)?.adresse || "");
    toast(estBorneFavorite(nom, b.lat, b.lon) ? "⭐ Borne ajoutée aux favoris" : "Borne retirée des favoris");
    remplirFiche(b, ctx);
  });
  $("ev-borne-partager-btn")?.addEventListener("click", () => partagerTexte(nom, `${nom}\n${b.adresse || ""}\n${lienGoogleMaps(b.lat, b.lon)}`));
}

function ouvrirBorne(b, { contexteArret = null, centrerCarte = true, remplacer = false } = {}) {
  borneOuverte = { b, ctx: contexteArret };
  if (remplacer && vueCourante === "borne") {
    $("ev-feuille-corps").scrollTop = 0;
  } else {
    afficherVue("borne");
  }
  selectionnerBorne(b);
  if (centrerCarte || !remplacer) centrer(b.lat, b.lon, Math.max(zoomActuel(), 14));
  remplirFiche(b, contexteArret);
  const nom = b.nom_borne || b.nom || "";
  $("ev-station-note-input").value = obtenirNoteBorne(nom, b.lat, b.lon);

  if (b.officiel === undefined) {
    enrichirBornes([b]).then(appliquerAbonnements).then(() => {
      if (borneOuverte?.b === b) remplirFiche(b, contexteArret);
      rafraichirBorne(b);
    });
  }
}

function cablerFiche() {
  $("ev-station-note-save-btn").addEventListener("click", () => {
    if (!borneOuverte) return;
    const { b } = borneOuverte;
    definirNoteBorne(b.nom_borne || b.nom || "", b.lat, b.lon, $("ev-station-note-input").value || "");
    toast("📝 Note enregistrée");
  });
}

// ── Partage ────────────────────────────────────────────────────────────────

async function partagerTexte(titre, texte) {
  if (navigator.share) {
    try {
      await navigator.share({ title: titre, text: texte });
    } catch (e) {
      if (e.name !== "AbortError") toast("Partage impossible sur cet appareil.");
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(texte);
    toast("📋 Copié dans le presse-papiers");
  } catch {
    location.href = `mailto:?subject=${encodeURIComponent(titre)}&body=${encodeURIComponent(texte)}`;
  }
}

// ── Formulaire de trajet ───────────────────────────────────────────────────

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

function cablerFormulaire() {
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
  document.querySelectorAll(".ev-charge-mode-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode || "confort";
      if (slidersModifiesManuellement && !confirm("Tu as modifié la marge ou l'objectif de charge à la main. Choisir un mode remplace ces réglages par ses valeurs. Continuer ?")) return;
      modeTrajet = mode;
      slidersModifiesManuellement = false;
      activerModeVisuel(mode);
      appliquerPresetMode(mode);
    }),
  );
  $("ev-depart-gps-btn").addEventListener("click", () => ($("ev-depart-input").value = "Ma position"));
  $("ev-inverser-btn").addEventListener("click", () => {
    const d = $("ev-depart-input").value;
    $("ev-depart-input").value = $("ev-destination-input").value;
    $("ev-destination-input").value = d;
  });
  $("ev-destination-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
      lancerTrajet();
    }
  });
  $("ev-trajet-run-btn").addEventListener("click", lancerTrajet);
  $("ev-aller-retour-btn").addEventListener("click", lancerAllerRetour);
  $("ev-scenarios-btn").addEventListener("click", lancerScenarios);
  $("ev-voir-resultat-btn").addEventListener("click", () => {
    if (dernierTrajet) afficherResultat(dernierTrajet);
  });
  $("ev-favori-trajet-btn").addEventListener("click", () => {
    const destination = $("ev-destination-input").value.trim();
    if (!destination) {
      toast("Indique d'abord une destination.");
      return;
    }
    ajouterTrajetFavori($("ev-depart-input").value.trim() || "Ma position", destination);
    toast("⭐ Trajet ajouté aux favoris");
  });
}

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
    slidersModifiesManuellement =
      !!preset && (preset.marge_pct !== Number(p.marge_pct ?? preset.marge_pct) || preset.cible_pct !== Number(p.cible_pct ?? preset.cible_pct));
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
    arret_impose: arretImposeChoisi(),
  };
  for (const [cle, id] of Object.entries(CASES)) options[cle] = $(id).checked;
  dernieresOptions = options;
  return options;
}

function sauverPrefsDepuis(options) {
  const { depart_prevu: _ponctuel, arret_impose: _parDestination, ...aGarder } = options;
  sauverPrefs({ ...aGarder, seuil_cout_eur: $("ev-seuil-cout-input").value.trim() });
}

// ── Calculs ────────────────────────────────────────────────────────────────

async function avecVerrou(boutonId, texteAttente, action) {
  if (calculEnCours) return;
  calculEnCours = true;
  const bouton = $(boutonId);
  const texteOrigine = bouton.textContent;
  bouton.textContent = texteAttente;
  BOUTONS_CALCUL.forEach((id) => ($(id).disabled = true));
  $("ev-trajet-erreur").classList.add("hidden");
  try {
    await action();
  } catch (e) {
    console.error(e);
    montrerErreurTrajet(`Erreur inattendue : ${e?.message || e}`);
  } finally {
    calculEnCours = false;
    bouton.textContent = texteOrigine;
    BOUTONS_CALCUL.forEach((id) => ($(id).disabled = false));
  }
}

function montrerErreurTrajet(message) {
  const zone = $("ev-trajet-erreur");
  zone.textContent = `⚠️ ${message}`;
  zone.classList.remove("hidden");
  if (vueCourante !== "trajet") afficherVue("trajet");
  zone.scrollIntoView({ behavior: "smooth", block: "center" });
}

function exigerDestination(options) {
  if (options.destination) return true;
  toast("Indique une destination.");
  $("ev-destination-input").focus();
  return false;
}

async function lancerTrajet() {
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou("ev-trajet-run-btn", "⏳ Calcul en cours…", async () => {
    sauverPrefsDepuis(options);
    oublierItineraires();
    const resultat = await planifierTrajet(options.depart, options.destination, { ...options, avec_alternatives: true });
    const bruts = resultat.itineraires_alternatifs || [];
    delete resultat.itineraires_alternatifs;
    if (!resultat.ok) return montrerErreurTrajet(resultat.erreur || "Calcul impossible.");
    itineraires.plans = [resultat, ...bruts.map(() => null)];
    itineraires.routes = [resultat, ...bruts];
    afficherResultat(resultat);
    annoncer(resultat);
    // Sans attendre : le résultat principal reste utilisable pendant ce temps.
    planifierItinerairesAlternatifs(bruts, options, itineraires.jeton);
  });
}

function oublierItineraires() {
  itineraires = { jeton: itineraires.jeton + 1, plans: [], routes: [] };
}

async function planifierItinerairesAlternatifs(bruts, options, jeton) {
  for (let i = 0; i < bruts.length; i++) {
    let plan;
    try {
      // En arrière-plan, on peut attendre que le quota Open-Meteo se libère
      // pour que chaque route ait relief et météo, comme la principale.
      plan = await planifierAlternative(bruts[i], { ...options, patience_open_meteo_ms: 70000 });
    } catch (e) {
      console.error(e);
      plan = { ok: false, erreur: `Erreur inattendue : ${e?.message || e}` };
    }
    if (jeton !== itineraires.jeton) return;
    itineraires.plans[i + 1] = plan;
    if (trajetAffiche && !navigationActive() && itineraires.plans.includes(dernierTrajet)) afficherItineraires(dernierTrajet);
  }
}

async function lancerAllerRetour() {
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou("ev-aller-retour-btn", "⏳ Aller + retour…", async () => {
    oublierItineraires();
    sauverPrefsDepuis(options);
    const { aller, retour } = await planifierAllerRetour(options.depart, options.destination, options);
    if (!aller.ok) return montrerErreurTrajet(aller.erreur || "Calcul impossible.");
    afficherResultat({ ...aller, retour });
    annoncer(aller);
  });
}

async function lancerScenarios() {
  const options = construireOptions();
  if (!exigerDestination(options)) return;
  await avecVerrou("ev-scenarios-btn", "⏳ 4 modes…", async () => {
    const table = $("ev-scenarios-table");
    table.innerHTML = hint("Calcul des 4 modes en cours…");
    table.classList.remove("hidden");
    table.scrollIntoView({ behavior: "smooth", block: "start" });
    sauverPrefsDepuis(options);
    renderScenarios(await comparerScenarios(options.depart, options.destination, options));
  });
}

function annoncer(r) {
  if (!lireReglages().annonce_vocale || !("speechSynthesis" in window)) return;
  let phrase = `Trajet de ${nomCourt(r.from_name)} à ${nomCourt(r.to_name)} : ${Math.round(r.distance_km)} kilomètres, environ ${r.duree_text} de route.`;
  if (r.nb_arrets === 0) {
    phrase += ` Vous arrivez avec ${Math.round(r.pct_batterie_arrivee)} pour cent de batterie, pas besoin de recharger.`;
  } else {
    const premier = r.arrets[0];
    phrase +=
      ` Il vous faudra ${r.nb_arrets} arrêt${r.nb_arrets > 1 ? "s" : ""} de recharge, le premier à ${premier.nom_borne}` +
      ` après ${Math.round(premier.km_depuis_depart)} kilomètres, environ ${premier.temps_charge_min} minutes de charge.` +
      ` Vous arriverez avec ${Math.round(r.pct_batterie_arrivee)} pour cent de batterie.`;
  }
  const voix = new SpeechSynthesisUtterance(phrase);
  voix.lang = "fr-FR";
  speechSynthesis.cancel();
  speechSynthesis.speak(voix);
}

// ── Résultat ───────────────────────────────────────────────────────────────

function etapesHtml(p) {
  const arrets = p.arrets || [];
  const departMs = p.depart_ms || Date.now();
  let chargeCumulMin = 0;
  const pointHoraire = (km) => departMs + (minutesDepuisKm(p, km) + chargeCumulMin) * 60000;
  const route = (kmA, kmB) => {
    const min = minutesDepuisKm(p, kmB) - minutesDepuisKm(p, kmA);
    return `<div class="ev-etape-route">↓ ${nombre(kmB - kmA)} km · ${formaterMinutes(Math.max(0, min))} de route</div>`;
  };

  let html = `
    <div class="ev-etape depart">
      <div class="ev-etape-rail"><div class="ev-etape-icone">🚗</div></div>
      <div class="ev-etape-corps">
        <div class="ev-etape-titre">Départ · ${escapeHtml(nomCourt(p.from_name))}</div>
        <div class="ev-etape-sous">${heure(departMs)} · ${batterieHtml(dernierChargeDepartPct)}</div>
        ${route(0, arrets.length ? arrets[0].km_depuis_depart : p.distance_km)}
      </div>
    </div>`;

  arrets.forEach((a, i) => {
    const arriveeMs = pointHoraire(a.km_depuis_depart);
    chargeCumulMin += a.temps_charge_min;
    const cb = etatCb(a);
    const suivant = i + 1 < arrets.length ? arrets[i + 1].km_depuis_depart : p.distance_km;
    html += `
      <div class="ev-etape arret">
        <div class="ev-etape-rail"><div class="ev-etape-icone">🔋</div></div>
        <div class="ev-etape-corps">
          <div class="ev-etape-titre">Arrêt ${a.numero} · km ${nombre(a.km_depuis_depart)}</div>
          <div class="ev-etape-sous">Arrivée ${heure(arriveeMs)} · repart ${heure(arriveeMs + a.temps_charge_min * 60000)}</div>
          <div class="ev-etape-carte" data-arret="${i}">
            <strong>${a.impose ? "⭐ " : ""}${escapeHtml(a.nom_borne)}</strong>${a.impose ? ` <span class="ev-cb-pill ok">Votre aire</span>` : ""}
            <div class="ev-borne-sous">${badgeOperateur(a.operateur)}${escapeHtml(a.operateur || "")}${a.adresse ? ` · ${escapeHtml(a.adresse)}` : ""}</div>
            <div class="ev-meta"><span>⚡ ${a.puissance_kw} kW</span><span>+${a.kwh_ajoutes} kWh</span><span>⏱️ ${a.temps_charge_min} min</span></div>
            <div>${batterieHtml(a.pct_arrivee_borne)} → ${batterieHtml(a.pct_depart_borne)}</div>
            <div class="ev-borne-pastilles">${pastilleEtat(a.etat_dynamique)}<span class="ev-cb-pill ${cb.classe}">${cb.court}</span><span class="ev-cb-pill neutre">${coutHtml(a.cout_estime_eur, a.prix_kwh_eur, a.prix_est_estimation)}</span></div>
          </div>
          ${route(a.km_depuis_depart, suivant)}
        </div>
      </div>`;
  });

  html += `
    <div class="ev-etape arrivee">
      <div class="ev-etape-rail"><div class="ev-etape-icone">🏁</div></div>
      <div class="ev-etape-corps">
        <div class="ev-etape-titre">Arrivée · ${escapeHtml(nomCourt(p.to_name))}</div>
        <div class="ev-etape-sous">vers ${heure(pointHoraire(p.distance_km))} · ${batterieHtml(p.pct_batterie_arrivee)}</div>
      </div>
    </div>`;
  return html;
}

function afficherResultat(p) {
  dernierTrajet = p;
  trajetAffiche = true;
  $("ev-voir-resultat-btn").classList.remove("hidden");
  $("ev-scenarios-table").classList.toggle("hidden", !dernierScenarios);

  $("ev-resultat-titre").textContent = `${nomCourt(p.from_name).split(",")[0]} → ${nomCourt(p.to_name).split(",")[0]}`;
  const tuiles = [
    tuile("cyan", `${nombre(p.distance_km)} km`, "Distance"),
    tuile("violet", p.duree_text, "Route"),
    tuile("cyan", p.duree_totale_min != null ? formaterMinutes(p.duree_totale_min) : "—", "Total avec charge"),
    tuile(p.nb_arrets === 0 ? "good" : "warn", p.nb_arrets === 0 ? "Aucun" : String(p.nb_arrets), p.nb_arrets ? `Arrêt(s) · ${p.temps_charge_total_min} min` : "Arrêt"),
    tuile(classeBatterie(p.pct_batterie_arrivee), `${nombre(p.pct_batterie_arrivee)} %`, "À l'arrivée"),
    tuile(p.depasse_seuil_cout ? "bad" : "good", p.cout_total_eur ? euros(p.cout_total_eur) : "0 €", "Coût en route"),
  ].join("");
  let meteo = "";
  if (p.meteo_info) {
    meteo = p.meteo_info.ok
      ? `🌡️ Météo au départ : ${p.meteo_info.temperature_c} °C (${p.meteo_info.description}) — conso ×${p.meteo_info.multiplicateur}`
      : "🌡️ Météo indisponible : réglage saisonnier utilisé.";
  }
  let retour = "";
  if (p.retour) {
    retour = p.retour.ok
      ? `↩️ Retour : ${nombre(p.retour.distance_km)} km, ${p.retour.duree_text}, ${p.retour.nb_arrets} arrêt(s), arrivée à ${nombre(p.retour.pct_batterie_arrivee)} % (tracé orange).`
      : `↩️ Retour impossible à calculer : ${p.retour.erreur}`;
  }
  $("ev-trajet-summary").innerHTML = `<div class="ev-tuiles">${tuiles}</div>${meteo ? `<div class="ev-meteo-info">${escapeHtml(meteo)}</div>` : ""}${
    retour ? `<div class="ev-meteo-info">${escapeHtml(retour)}</div>` : ""
  }`;

  const alerteCout = $("ev-cout-alerte");
  alerteCout.textContent = p.depasse_seuil_cout ? `⚠️ Le coût estimé (${euros(p.cout_total_eur)}) dépasse le seuil que tu as fixé.` : "";
  alerteCout.classList.toggle("hidden", !p.depasse_seuil_cout);

  $("ev-etapes").innerHTML = etapesHtml(p) + echangeursHtml(p) + boutonQuandPartir();
  $("ev-quand-partir-btn").addEventListener("click", () => quandPartir(p));
  $("ev-etapes")
    .querySelectorAll("[data-arret]")
    .forEach((el) => el.addEventListener("click", () => {
      const a = p.arrets[Number(el.dataset.arret)];
      ouvrirBorne(a, { contexteArret: a });
    }));

  const d = p.comparaison_domicile;
  const domicile = $("ev-domicile-box");
  if (d && d.economie_eur > 0.5) {
    const detail =
      d.cout_hc_eur != null
        ? `${euros(d.cout_hc_eur)} en heures creuses (${euros(d.prix_hc_eur_kwh)}/kWh) ou ${euros(d.cout_hp_eur)} en heures pleines (${euros(d.prix_hp_eur_kwh)}/kWh)`
        : `${euros(d.cout_domicile_eur)}`;
    const profil = obtenirProfilVehicule();
    const kwMaison = profil.puissance_domicile_kw || 7.4;
    const dureeMaison = formaterMinutes(calculerTempsCharge(d.kwh, kwMaison, { pctDebut: 20, profil }));
    domicile.innerHTML = `💡 Ces ${nombre(d.kwh, 1)} kWh coûteraient ${detail} à la maison, contre ${euros(d.cout_public_eur)} en public.<br>Économie possible : <strong>${euros(d.economie_eur)}</strong>${
      d.part_hc_pct != null ? ` (avec ${escapeHtml(d.part_hc_pct)} % en heures creuses)` : ""
    }.<br>🏠 Sur ta borne de ${nombre(kwMaison, 1)} kW : environ <strong>${dureeMaison}</strong> de charge avant de partir.`;
    domicile.classList.remove("hidden");
  } else {
    domicile.classList.add("hidden");
  }

  if (p.confiance) {
    const c = p.confiance;
    const classe = c.score >= 70 ? "" : c.score >= 40 ? "warn" : "bad";
    $("ev-confiance-box").innerHTML = `<h3>✅ Fiabilité du plan</h3><div><span class="ev-score ${classe}">${c.score}/100</span></div>
      <div class="ev-details-score">${c.details.map((x) => `<span>${x.points >= 0 ? "+" : ""}${x.points} ${escapeHtml(x.label)}</span>`).join("")}</div>`;
  }

  $("ev-maps-link").href = lienGoogleMaps(p.to_lat, p.to_lon);
  $("ev-qrcode-box").classList.add("hidden");
  $("ev-qrcode-box").innerHTML = "";

  afficherVue("resultat");
  afficherTrajet(p, (arret) => ouvrirBorne(arret, { contexteArret: arret }));
  afficherItineraires(p);
  renderProfilTrajet(p);
  preparerFrise(p);
}

// ── Itinéraires alternatifs ────────────────────────────────────────────────

// Indice du meilleur plan selon `cle`, ou null si tous se valent (un badge
// « le moins cher » n'a pas de sens quand tout coûte 0 €).
function meilleurPlan(plans, cle) {
  const valides = plans.map((p, i) => ({ v: p?.ok ? p[cle] : null, i })).filter((x) => Number.isFinite(x.v));
  if (valides.length < 2) return null;
  const min = Math.min(...valides.map((x) => x.v));
  const max = Math.max(...valides.map((x) => x.v));
  return min < max ? valides.find((x) => x.v === min).i : null;
}

function badgesItineraires(plans) {
  const badges = plans.map(() => []);
  const ajouter = (i, texte) => i !== null && badges[i].push(texte);
  ajouter(meilleurPlan(plans, "duree_totale_min"), "⚡ Le plus rapide");
  ajouter(meilleurPlan(plans, "cout_total_eur"), "💶 Le moins cher");
  ajouter(meilleurPlan(plans, "distance_km"), "📏 Le plus court");
  if (plans.some((p) => p?.ok && p.km_peage > 0)) plans.forEach((p, i) => p?.ok && p.km_peage === 0 && badges[i].push("🚫 Sans péage"));
  return badges;
}

function ecartMinutes(min) {
  if (Math.abs(min) < 1) return "même durée";
  return `${min > 0 ? "+" : "−"}${formaterMinutes(Math.abs(min))}`;
}

function carteItineraire(i, plan, route, badges, affiche) {
  const choisi = plan === affiche;
  const titre = `<div class="ev-itin-tete"><strong>Itinéraire ${i + 1}</strong>${choisi ? `<span class="ev-itin-coche">✓ affiché</span>` : ""}</div>`;
  const pastilles = badges.length ? `<div class="ev-itin-badges">${badges.map((b) => `<span class="ev-cb-pill ok">${b}</span>`).join("")}</div>` : "";
  const routeTxt = `${nombre(route.distance_km)} km · ${route.duree_text} de route`;
  if (!plan) {
    return `<div class="ev-itineraire attente">${titre}<div class="ev-itin-ligne">${routeTxt}</div><div class="ev-itin-sous">⏳ Calcul des recharges…</div></div>`;
  }
  if (!plan.ok) {
    return `<div class="ev-itineraire attente">${titre}<div class="ev-itin-ligne">${routeTxt}</div><div class="ev-itin-sous">⚠️ ${escapeHtml(plan.erreur || "Plan de recharge impossible.")}</div></div>`;
  }
  const arrets = plan.nb_arrets ? `${plan.nb_arrets} arrêt${plan.nb_arrets > 1 ? "s" : ""}` : "sans arrêt";
  const ligne = `🏁 <strong>${formaterMinutes(plan.duree_totale_min ?? plan.duree_min)}</strong> au total · ${routeTxt} · ${arrets} · ${plan.cout_total_eur ? euros(plan.cout_total_eur) : "0 €"} · 🔋 ${nombre(plan.pct_batterie_arrivee)} %`;
  const details = [];
  if (plan.km_autoroute) details.push(`🛣️ ${nombre(plan.km_autoroute)} km d'autoroute`);
  details.push(plan.km_peage ? `péage sur ${nombre(plan.km_peage)} km` : "sans péage");
  if (plan.retard_trafic_min >= 5) details.push(`🚦 ${formaterMinutes(plan.retard_trafic_min)} de bouchons`);
  if (!choisi && affiche?.ok) details.push(`${ecartMinutes((plan.duree_totale_min ?? 0) - (affiche.duree_totale_min ?? 0))} par rapport à l'affiché`);
  return `<button type="button" class="ev-itineraire${choisi ? " choisi" : ""}" data-itin="${i}">${titre}${pastilles}<div class="ev-itin-ligne">${ligne}</div><div class="ev-itin-sous">${details.join(" · ")}</div></button>`;
}

// Feuille de route des voies rapides : « km 45 · Sortie 4 · D31 ➜ Laval ».
const LIBELLES_ECHANGEUR = { entree: "↗️ Entrée", sortie: "↘️ Sortie", echangeur: "🔀 Échangeur" };

function echangeursHtml(p) {
  const liste = p.echangeurs || [];
  if (!liste.length) return "";
  const lignes = liste
    .map((e) => {
      const badges = [
        e.sortie ? `<span class="ev-num ev-num-sortie">${escapeHtml(e.sortie)}</span>` : "",
        ...e.numeros.map((n) => `<span class="ev-num ev-num-${classeNumero(n)}">${escapeHtml(n)}</span>`),
      ].join("");
      return `<div class="ev-echangeur"><span class="ev-echangeur-km">km ${nombre(e.km, e.km < 10 ? 1 : 0)}</span><span>${LIBELLES_ECHANGEUR[e.type]}</span>${badges}${e.direction ? `<span class="ev-echangeur-dir">➜ ${escapeHtml(e.direction)}</span>` : ""}</div>`;
    })
    .join("");
  return `<details class="ev-accordeon ev-echangeurs"><summary>🛣️ Sorties et échangeurs (${liste.length})</summary><div class="ev-echangeurs-liste">${lignes}</div></details>`;
}

function choisirItineraire(i) {
  const plan = itineraires.plans[i];
  if (!plan) return toast("Plan de recharge de cet itinéraire encore en calcul…");
  if (!plan.ok) return toast(plan.erreur || "Plan de recharge impossible pour cet itinéraire.");
  if (plan !== dernierTrajet) afficherResultat(plan);
}

function afficherItineraires(p) {
  const zone = $("ev-itineraires");
  const index = itineraires.plans.indexOf(p);
  if (index < 0 || itineraires.routes.length < 2) {
    zone.classList.add("hidden");
    zone.innerHTML = "";
    afficherAlternatives([]);
    return;
  }
  const badges = badgesItineraires(itineraires.plans);
  const cartes = itineraires.routes.map((route, i) => carteItineraire(i, itineraires.plans[i], route, badges[i], p)).join("");
  zone.innerHTML = `<h3>🛣️ ${itineraires.routes.length} itinéraires proposés</h3>
    <div class="ev-itin-aide">Touche une route, ici ou sur la carte (en gris), pour voir son plan de recharge.</div>${cartes}`;
  zone.classList.remove("hidden");
  zone.querySelectorAll("[data-itin]").forEach((el) => el.addEventListener("click", () => choisirItineraire(Number(el.dataset.itin))));

  afficherAlternatives(
    itineraires.routes
      .map((route, i) => ({ route, i }))
      .filter(({ i }) => i !== index)
      .map(({ route, i }) => {
        const plan = itineraires.plans[i];
        const duree = plan?.ok ? `${formaterMinutes(plan.duree_totale_min ?? plan.duree_min)} au total` : `${route.duree_text} de route`;
        return { coords: route.coords, libelle: `Itinéraire ${i + 1} · ${duree}`, onClic: () => choisirItineraire(i) };
      }),
  );
}

function quitterTrajet() {
  effacerTrajet();
  trajetAffiche = false;
  detruireCourbe();
  afficherVue("bornes", { etat: "bas", historique: false });
  chargerBornesZone(true);
}

// Navigation coupée (appli fermée, téléphone redémarré…) : on propose de la
// reprendre là où elle en était, avec la dernière batterie estimée.
function proposerRepriseNavigation() {
  const s = navigationInterrompue();
  if (!s) return;
  const bandeau = document.createElement("div");
  bandeau.className = "ev-maj";
  bandeau.innerHTML = `<span>🧭 Navigation interrompue vers ${escapeHtml(nomCourt(s.destination || "ta destination"))}</span><span class="ev-maj-boutons"><button type="button" class="ev-btn" data-reprise="oui">Reprendre</button><button type="button" class="ev-lien" data-reprise="non">✕</button></span>`;
  document.body.appendChild(bandeau);
  bandeau.querySelector('[data-reprise="oui"]').addEventListener("click", () => {
    bandeau.remove();
    dernierTrajet = s.plan;
    dernierChargeDepartPct = s.batterie_pct;
    dernieresOptions = s.options;
    lancerNavigation(false);
  });
  bandeau.querySelector('[data-reprise="non"]').addEventListener("click", () => {
    bandeau.remove();
    oublierNavigationInterrompue();
  });
}

function lancerNavigation(demo) {
  if (!dernierTrajet || navigationActive()) return;
  const options = dernieresOptions || construireOptions();
  demarrerNavigation(dernierTrajet, {
    options,
    demo,
    chargeDepartPct: dernierChargeDepartPct,
    // Recalcul des recharges en route, depuis la position actuelle de la voiture.
    onReplanifier: async (departCoordonnees, chargePct, restants = []) => {
      const o = { ...options, charge_pct: chargePct, depart_prevu: null };
      // Aire préférée déjà passée : ne pas y renvoyer.
      const imp = o.arret_impose;
      if (imp && !restants.some((a) => Math.abs(a.lat - imp.lat) < 0.01 && Math.abs(a.lon - imp.lon) < 0.01)) o.arret_impose = null;
      // Itinéraire choisi parmi les alternatives : on reste dessus.
      if (dernierTrajet.suivre_trace) {
        const [lat, lon] = departCoordonnees.split(",").map(Number);
        o.trace_imposee = [[lon, lat], ...traceRestante(dernierTrajet.coords, lat, lon).coords];
      }
      const plan = await planifierTrajet(departCoordonnees, o.destination, o, false);
      if (plan.ok) {
        dernierTrajet = plan;
        dernierChargeDepartPct = chargePct;
      }
      return plan;
    },
    onFin: () => {
      if (dernierTrajet) afficherResultat(dernierTrajet);
    },
  });
}

// Télécharge la carte du trajet et son guidage pour rouler sans réseau.
async function preparerTrajetHorsLigne() {
  if (!dernierTrajet?.coords?.length) return;
  const bouton = $("ev-hors-ligne-btn");
  const { tuiles, mo } = estimerPreparation(dernierTrajet);
  if (!confirm(`Préparer ce trajet pour rouler sans réseau ?\n\nCarte le long du tracé : environ ${tuiles} morceaux (~${mo} Mo), plus le guidage.\nMieux vaut être en wifi.`)) return;
  bouton.disabled = true;
  try {
    const r = await preparerHorsLigne(dernierTrajet, (fait, total) => {
      if (fait % 25 === 0 || fait === total) toast(`📥 Préparation hors ligne : ${Math.round((fait / total) * 100)} %`);
    });
    toast(`✅ Prêt hors ligne : ${r.tuiles}/${r.tuilesTotal} morceaux de carte${r.guidage ? " + guidage" : " (guidage indisponible)"}. Utilise la vue 3D sans réseau.`);
  } catch (e) {
    toast(`⚠️ Préparation impossible : ${e.message}`);
  } finally {
    bouton.disabled = false;
  }
}

function cablerResultat() {
  $("ev-nav-demarrer-btn").addEventListener("click", () => lancerNavigation(false));
  $("ev-nav-demo-btn").addEventListener("click", () => lancerNavigation(true));
  $("ev-modifier-btn").addEventListener("click", () => afficherVue("trajet"));
  $("ev-quitter-trajet-btn").addEventListener("click", quitterTrajet);
  $("ev-export-btn").addEventListener("click", () => {
    if (dernierTrajet) telechargerTexte(`trajet_ve_${Date.now()}.txt`, exporterTrajetTexte(dernierTrajet));
  });
  $("ev-partager-btn").addEventListener("click", () => {
    if (dernierTrajet) partagerTexte(`Trajet électrique : ${nomCourt(dernierTrajet.from_name)} → ${nomCourt(dernierTrajet.to_name)}`, exporterTrajetTexte(dernierTrajet));
  });
  $("ev-hors-ligne-btn").addEventListener("click", preparerTrajetHorsLigne);
  $("ev-qrcode-btn").addEventListener("click", () => {
    if (!dernierTrajet) return;
    const box = $("ev-qrcode-box");
    const texte = `Trajet : ${nomCourt(dernierTrajet.from_name)} -> ${nomCourt(dernierTrajet.to_name)} (${dernierTrajet.distance_km} km). Destination : ${lienGoogleMaps(dernierTrajet.to_lat, dernierTrajet.to_lon)}`;
    box.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(texte)}" alt="QR code du trajet" width="220" height="220">`;
    box.classList.toggle("hidden");
  });
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
    table.innerHTML = alerte(`Erreur : ${payload.erreur || "inconnue"}`);
    return;
  }
  dernierScenarios = payload;
  const colonnes = Object.entries(payload.scenarios)
    .map(([mode, r]) => {
      if (!r.ok) return `<div class="ev-scenario"><div class="ev-scenario-mode">${LABELS_MODE[mode] || mode}</div>${hint(r.erreur || "Erreur")}</div>`;
      return `
      <div class="ev-scenario">
        <div class="ev-scenario-mode">${LABELS_MODE[mode] || mode}</div>
        <div class="ev-scenario-ligne"><span>🏁 Total</span><strong>${formaterMinutes(r.duree_totale_min ?? 0)}</strong></div>
        <div class="ev-scenario-ligne"><span>⏱️ Charge</span><strong>${r.temps_charge_total_min} min</strong></div>
        <div class="ev-scenario-ligne"><span>💶 Coût</span><strong>${euros(r.cout_total_eur)}</strong></div>
        <div class="ev-scenario-ligne"><span>🔋 Arrivée</span><strong>${nombre(r.pct_batterie_arrivee)} %</strong></div>
        <div class="ev-scenario-ligne"><span>🔌 Arrêts</span><strong>${r.nb_arrets}</strong></div>
        <div class="ev-scenario-ligne"><span>✅ Fiabilité</span><strong>${r.confiance?.score ?? "?"}/100</strong></div>
        <button type="button" class="ev-btn ev-scenario-choisir" data-mode="${mode}">Choisir</button>
      </div>`;
    })
    .join("");
  table.innerHTML = `<h3>📊 Comparaison des modes <button type="button" id="ev-scenarios-export-btn" class="ev-lien">⬇️ Exporter</button></h3><div class="ev-scenarios-grille">${colonnes}</div>`;
  table.querySelectorAll(".ev-scenario-choisir").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode || "confort";
      modeTrajet = mode;
      slidersModifiesManuellement = false;
      activerModeVisuel(mode);
      appliquerPresetMode(mode);
      afficherResultat(payload.scenarios[mode]);
    }),
  );
  $("ev-scenarios-export-btn").addEventListener("click", () =>
    telechargerTexte(`trajet_ve_modes_${Date.now()}.txt`, exporterScenariosTexte(payload.depart, payload.destination, payload.scenarios)),
  );
}

// ── Profil du trajet (courbes) ─────────────────────────────────────────────

let vueCourbe = "batterie";

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
  const stat = (icone, texte) => `<span>${icone} ${texte}</span>`;
  const stats = [
    stat("⚡", `<strong>${nombre(s.conso_moyenne_kwh100, 1)}</strong> kWh/100 km`),
    stat("🔋", `<strong>${nombre(s.energie_totale_kwh, 1)}</strong> kWh au total`),
  ];
  if (s.vitesse_moyenne_kmh) stats.push(stat("🚗", `<strong>${nombre(s.vitesse_moyenne_kmh)}</strong> km/h de moyenne`));
  if (pt.relief_ok) {
    stats.push(stat("⛰️", `+<strong>${nombre(s.denivele_positif_m)}</strong> m / −<strong>${nombre(s.denivele_negatif_m)}</strong> m`));
    stats.push(stat("🏔️", `alt. max <strong>${nombre(s.altitude_max_m)}</strong> m`));
  }
  if (pt.meteo_ok) {
    stats.push(stat("🌡️", `<strong>${nombre(s.temperature_min)}</strong> à <strong>${nombre(s.temperature_max)}</strong> °C`));
    stats.push(stat("🌧️", s.km_sous_la_pluie > 0.5 ? `pluie sur <strong>${nombre(s.km_sous_la_pluie)}</strong> km` : "pas de pluie prévue"));
    const vent = s.vent_face_moyen_kmh;
    stats.push(stat("💨", Math.abs(vent) < 3 ? "vent neutre" : `vent ${vent > 0 ? "de face" : "dans le dos"} ~<strong>${nombre(Math.abs(vent))}</strong> km/h`));
  }
  $("ev-profil-stats").innerHTML = stats.join("");

  const notes =
    p.modele === "detaille"
      ? [
          "Conso calculée tronçon par tronçon : vitesse (limitations et trafic TomTom)",
          pt.relief_ok ? "relief" : "relief indisponible (supposé plat)",
          pt.meteo_ok ? "météo à l'heure de passage" : "réglage saisonnier du profil",
        ]
      : ["Consommation constante (mode JARVIS) — coche « Calcul détaillé » dans les options avancées pour tenir compte de la vitesse et du relief"];
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
  else if (!window.Chart) message = "Courbes indisponibles (module graphique non chargé : pas de connexion ?).";
  else if (vueCourbe === "meteo" && !pt.meteo_ok) message = "Coche « 🌦️ Météo réelle sur le trajet » dans les options avancées, puis relance le calcul.";
  vide.textContent = message;
  vide.classList.toggle("hidden", !message);
  conteneur.classList.toggle("hidden", !!message);
  if (message) {
    detruireCourbe();
    return;
  }
  afficherCourbe($("ev-courbe-canvas"), pt, dernierTrajet.arrets, vueCourbe, (km) => sauterFriseAuKm(km));
}

// ── Frise "où serai-je ?" ──────────────────────────────────────────────────

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
  return p.duree_min > 0 ? Math.max(0, Math.min(1, minutes / p.duree_min)) * p.distance_km : 0;
}

function minutesDepuisKm(p, km) {
  const table = tableTemps(p);
  if (table) return interpoler(table.km, table.min, km);
  return p.distance_km > 0 ? (km / p.distance_km) * p.duree_min : 0;
}

function estimerBatteriePourDistance(distanceKm, p) {
  const courbe = p.profil_trajet?.batterie;
  if (courbe && courbe.length > 1) {
    for (let i = courbe.length - 1; i > 0; i--) {
      const a = courbe[i - 1];
      const b = courbe[i];
      if (distanceKm >= a.km && distanceKm <= b.km) return b.km > a.km ? a.pct + ((b.pct - a.pct) * (distanceKm - a.km)) / (b.km - a.km) : b.pct;
    }
    return courbe[courbe.length - 1].pct;
  }
  const autonomie = p.autonomie_totale_km || 1;
  let departKm = 0;
  let departPct = dernierChargeDepartPct;
  for (const a of p.arrets || []) {
    if (distanceKm <= a.km_depuis_depart) return departPct - ((distanceKm - departKm) / autonomie) * 100;
    departKm = a.km_depuis_depart;
    departPct = a.pct_depart_borne;
  }
  return departPct - ((distanceKm - departKm) / autonomie) * 100;
}

function preparerFrise(p) {
  if (!(p.coords?.length && p.duree_min)) {
    $("ev-time-slider-row").classList.add("hidden");
    return;
  }
  $("ev-time-slider-row").classList.remove("hidden");
  $("ev-timeline-stops").innerHTML = (p.arrets || [])
    .map((a) => {
      const pct = (minutesDepuisKm(p, a.km_depuis_depart) / p.duree_min) * 100;
      return `<div class="ev-charge-timeline-stop" style="left:${pct}%" data-km="${a.km_depuis_depart}" title="Arrêt ${a.numero}">🔋</div>`;
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
}

function deplacerFrise(minutes) {
  const t = dernierTrajet;
  if (!t) return;
  const ratio = t.duree_min > 0 ? Math.max(0, Math.min(1, minutes / t.duree_min)) : 0;
  $("ev-timeline-puck").style.left = `${ratio * 100}%`;
  $("ev-timeline-fill").style.width = `${ratio * 100}%`;
  const km = kmDepuisMinutes(t, ratio * t.duree_min);
  $("ev-time-slider-value").textContent = minutes <= 0.5 ? "Départ" : `${formaterMinutes(minutes)} · km ${Math.round(km)}`;
  $("ev-timeline-battery-estimate").innerHTML = batterieHtml(Math.round(estimerBatteriePourDistance(km, t)));
}

let minuteurFrise = null;
let jetonFrise = 0;

function demanderBornesADistance(minutes) {
  if (!dernierTrajet) return;
  clearTimeout(minuteurFrise);
  minuteurFrise = setTimeout(async () => {
    const jeton = ++jetonFrise;
    const trajet = dernierTrajet;
    $("ev-time-slider-stations").innerHTML = hint("Recherche des bornes à ce point du trajet…");
    const r = await bornesADistance(trajet, kmDepuisMinutes(trajet, minutes));
    if (jeton !== jetonFrise || trajet !== dernierTrajet) return;
    const zone = $("ev-time-slider-stations");
    if (!r.ok) {
      zone.innerHTML = hint(`Erreur : ${r.erreur || "inconnue"}`);
      placerCurseur(undefined, undefined);
      return;
    }
    placerCurseur(r.lat, r.lon, `km ${r.distance_cible_km}`);
    const bornes = r.bornes || [];
    afficherListe(zone, bornes, "Aucune borne trouvée près de ce point.", " du tracé");
    appliquerAbonnements(await enrichirBornes(bornes));
    if (jeton === jetonFrise) afficherListe(zone, bornes, "Aucune borne trouvée près de ce point.", " du tracé");
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
  // Relâche toujours la capture : un glissement interrompu ne doit jamais bloquer la frise.
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
  cablerListe($("ev-time-slider-stations"), (b) => ouvrirBorne(b));
}

// ── Favoris ────────────────────────────────────────────────────────────────

let ongletFavoris = "trajets";

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
  afficherVue("trajet");
  lancerTrajet();
}

function ligneSimple(titre, sous, idx, idSuppr) {
  return `<div class="ev-borne-ligne" data-idx="${idx}">
    <div class="ev-borne-infos"><div class="ev-borne-nom">${titre}</div>${sous ? `<div class="ev-borne-sous">${sous}</div>` : ""}</div>
    <button type="button" class="ev-mini-btn" data-suppr="${escapeHtml(idSuppr)}" title="Supprimer">🗑️</button>
  </div>`;
}

function renderFavoris() {
  document.querySelectorAll(".ev-fav-onglet").forEach((b) => b.classList.toggle("active", b.dataset.onglet === ongletFavoris));
  $("ev-favoris-list").classList.toggle("hidden", ongletFavoris !== "trajets");
  $("ev-historique-bloc").classList.toggle("hidden", ongletFavoris !== "historique");
  $("ev-bornes-favorites-list").classList.toggle("hidden", ongletFavoris !== "bornes");

  const favoris = listerTrajetsFavoris();
  listesAffichees.set("ev-favoris-list", favoris);
  $("ev-favoris-list").innerHTML =
    favoris.map((f, i) => ligneSimple(`⭐ ${escapeHtml(f.depart)} → ${escapeHtml(f.destination)}`, "", i, f.id)).join("") ||
    hint("Aucun trajet favori. Utilise « ☆ Trajet favori » dans l'onglet Trajet.");

  const historique = listerHistoriqueTrajets();
  listesAffichees.set("ev-historique-list", historique);
  $("ev-historique-list").innerHTML =
    historique
      .map((h, i) =>
        ligneSimple(
          `${escapeHtml(nomCourt(h.from_name) || h.depart)} → ${escapeHtml(nomCourt(h.to_name) || h.destination)}`,
          escapeHtml(
            [`${h.distance_km} km`, h.duree_text, `${h.nb_arrets} arrêt(s)`, LABELS_MODE[h.reglages?.mode] || "", new Date(h.ts * 1000).toLocaleDateString("fr-FR")]
              .filter(Boolean)
              .join(" · "),
          ),
          i,
          h.id,
        ),
      )
      .join("") || hint("Aucun trajet calculé pour le moment.");

  const bornes = listerBornesFavorites();
  listesAffichees.set("ev-bornes-favorites-list", bornes);
  $("ev-bornes-favorites-list").innerHTML =
    bornes.map((b, i) => ligneSimple(`🔌 ${escapeHtml(b.nom)}`, escapeHtml(b.adresse || ""), i, b.id)).join("") ||
    hint("Aucune borne favorite. Ouvre la fiche d'une borne et touche ☆ Favori.");
}

function cablerFavoris() {
  document.querySelectorAll(".ev-fav-onglet").forEach((b) =>
    b.addEventListener("click", () => {
      ongletFavoris = b.dataset.onglet;
      renderFavoris();
    }),
  );
  const gerer = (id, ouvrir, supprimer) =>
    $(id).addEventListener("click", (e) => {
      const suppr = e.target.closest("[data-suppr]");
      if (suppr) {
        e.stopPropagation();
        supprimer(suppr.dataset.suppr);
        renderFavoris();
        return;
      }
      const ligne = e.target.closest("[data-idx]");
      const element = ligne && listesAffichees.get(id)?.[Number(ligne.dataset.idx)];
      if (element) ouvrir(element);
    });
  gerer("ev-favoris-list", (f) => chargerEtLancerTrajet(f.depart, f.destination), retirerTrajetFavori);
  gerer("ev-historique-list", (h) => chargerEtLancerTrajet(h.depart, h.destination, h.reglages), supprimerTrajetHistorique);
  gerer(
    "ev-bornes-favorites-list",
    (f) => {
      const connue = bornesZone.find((b) => haversineKm(b.lat, b.lon, f.lat, f.lon) < 0.06);
      ouvrirBorne(connue || { nom: f.nom, lat: f.lat, lon: f.lon, adresse: f.adresse, connecteurs: [] });
    },
    (id) => {
      const f = listerBornesFavorites().find((x) => x.id === id);
      if (f) basculerFavoriBorne(f.nom, f.lat, f.lon, f.adresse);
    },
  );
  $("ev-historique-clear-btn").addEventListener("click", () => {
    if (confirm("Effacer tout l'historique des trajets ?")) {
      effacerHistoriqueTrajets();
      renderFavoris();
    }
  });
}

// ── Outils : recherche de bornes et calculateur ────────────────────────────

function cablerOutils() {
  cablerJournal();
  const select = $("ev-recherche-operateur-select");
  select.addEventListener("change", () => {
    const autre = select.value === "__autre__";
    $("ev-recherche-operateur-input").classList.toggle("hidden", !autre);
    if (autre) $("ev-recherche-operateur-input").focus();
  });
  $("ev-recherche-rayon-input").addEventListener("input", () => ($("ev-recherche-rayon-value").textContent = $("ev-recherche-rayon-input").value));
  $("ev-recherche-gps-btn").addEventListener("click", () => ($("ev-recherche-lieu-input").value = "Ma position"));

  $("ev-recherche-run-btn").addEventListener("click", async () => {
    const operateur = select.value === "__autre__" ? $("ev-recherche-operateur-input").value.trim() : select.value;
    const rayon = parseFloat($("ev-recherche-rayon-input").value);
    const cb = $("ev-recherche-cb-checkbox").checked;
    const btn = $("ev-recherche-run-btn");
    btn.disabled = true;
    $("ev-recherche-etat").textContent = "⏳ Recherche en cours…";
    try {
      const r = await rechercherBornesAutour($("ev-recherche-lieu-input").value.trim() || "Ma position", {
        operateur,
        type_acces: $("ev-recherche-acces-select").value,
        rayon_km: rayon,
        carte_bancaire_uniquement: cb,
      });
      if (!r.ok) {
        $("ev-recherche-etat").textContent = `⚠️ ${r.erreur || "Recherche impossible."}`;
        return;
      }
      $("ev-recherche-etat").textContent = "";
      rechercheManuelle = [nomCourt(r.lieu).split(",")[0], operateur, cb ? "CB" : ""].filter(Boolean).join(" · ");
      jetonZone++;
      zoneIncomplete = false;
      bornesZone = r.bornes;
      derniereZone = { lat: r.lat, lon: r.lon, rayon };
      afficherVue("bornes", { etat: "mi", historique: false });
      centrer(r.lat, r.lon, Math.max(9, Math.min(14, 14 - Math.log2(rayon / 2))));
      renderBornes();
      const jeton = jetonZone;
      enrichirProgressivement(bornesZone, () => jeton === jetonZone);
    } finally {
      btn.disabled = false;
    }
  });

  $("ev-calc-run-btn").addEventListener("click", () => {
    const profil = obtenirProfilVehicule();
    const types = typesDeCharge(profil);
    const type = types[$("ev-calc-type-select").value] || types.rapide;
    const kwh = parseFloat($("ev-calc-kwh-input").value) || 0;
    // Calculateur : charge supposée partir de 20 % (cas le plus courant).
    const minutes = Math.round(calculerTempsCharge(kwh, type.puissance_kw, { pctDebut: 20, profil }));
    const resultat = $("ev-calc-result");
    resultat.classList.remove("hidden");
    resultat.innerHTML =
      `⏱️ Temps de charge : <strong>${formaterMinutes(minutes)}</strong> (à ${escapeHtml(type.puissance_kw)} kW)` +
      `<br>🏠 À la maison : <strong>${euros(kwh * profil.prix_hc_eur_kwh)}</strong> en heures creuses, <strong>${euros(kwh * profil.prix_hp_eur_kwh)}</strong> en heures pleines` +
      `<br>🔌 Sur borne publique (~${euros(0.45)}/kWh) : environ <strong>${euros(kwh * 0.45)}</strong>`;
  });
}

// ── Mode urgence ───────────────────────────────────────────────────────────

function cablerUrgence() {
  const panneau = $("ev-urgence-panel");
  const corps = $("ev-urgence-body");
  let bornesUrg = [];
  $("ev-urgence-btn").addEventListener("click", async () => {
    panneau.classList.remove("hidden");
    history.pushState({ urgence: true }, "");
    corps.innerHTML = hint("Recherche des bornes compatibles les plus proches de ta position…");
    const r = await bornesUrgence($("ev-depart-input").value.trim());
    if (!r.ok) {
      corps.innerHTML = alerte(`Erreur : ${r.erreur || "inconnue"}`);
      return;
    }
    bornesUrg = r.bornes || [];
    if (!bornesUrg.length) {
      corps.innerHTML = hint("Aucune borne compatible dans un rayon de 30 km. Élargis la recherche depuis l'onglet ⚡ Outils.");
      return;
    }
    corps.innerHTML =
      hint(`Autour de : ${nomCourt(r.lieu)}`) +
      bornesUrg
        .map((b, i) => {
          const kw = puissanceBorne(b);
          return `
        <div class="ev-urgence-carte ${i === 0 ? "principale" : ""}">
          <div class="ev-urgence-titre">${i === 0 ? "🎯 RECOMMANDÉE" : "🔁 Secours"} : ${escapeHtml(b.nom)}</div>
          <div class="ev-borne-sous">${escapeHtml(b.adresse || "")}</div>
          <div class="ev-meta"><span>📍 ${nombre(b.distance_km, 1)} km</span><span>⚡ ${kw} kW</span><span>${escapeHtml(b.operateur || "")}</span></div>
          <div class="ev-borne-pastilles">${pastillesBorne(b)}</div>
          <div class="ev-actions-rangee">
            <a class="ev-action" href="${lienGoogleMaps(b.lat, b.lon)}" target="_blank" rel="noopener"><span>🧭</span>Maps</a>
            <a class="ev-action" href="${lienWaze(b.lat, b.lon)}" target="_blank" rel="noopener"><span>🚗</span>Waze</a>
            <button class="ev-action" type="button" data-fiche="${i}"><span>📋</span>Fiche</button>
          </div>
        </div>`;
        })
        .join("");
  });
  corps.addEventListener("click", (e) => {
    const bouton = e.target.closest("[data-fiche]");
    if (!bouton) return;
    const b = bornesUrg[Number(bouton.dataset.fiche)];
    panneau.classList.add("hidden");
    history.replaceState({}, "");
    ouvrirBorne(b);
  });
  $("ev-urgence-close-btn").addEventListener("click", () => {
    if (history.state?.urgence) history.back();
    else panneau.classList.add("hidden");
  });
}

// ── Profil ─────────────────────────────────────────────────────────────────

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
  $("ev-profil-domicile").value = profil.puissance_domicile_kw ?? "";
  rendreAbonnements();
  majConsoMesuree();
  $("ev-profil-connecteurs").value = (profil.connecteurs_acceptes || []).join(", ");
  $("ev-profil-saison").value = profil.saison || "mi_saison";
  $("ev-profil-prix-hc").value = profil.prix_hc_eur_kwh;
  $("ev-profil-prix-hp").value = profil.prix_hp_eur_kwh;
  $("ev-profil-part-hc").value = profil.part_hc_pct;
  rendreReglagesProfil();
}

// Consommation mesurée en roulant (corrections de batterie en navigation).
function majConsoMesuree() {
  const mesure = consoMesuree();
  $("ev-conso-mesuree").innerHTML = mesure
    ? `Mesurée : <strong>${nombre(mesure.kwh_100km, 1)}</strong> sur ${mesure.km} km · <button type="button" class="ev-lien" id="ev-conso-utiliser-btn">Utiliser</button>`
    : "Se mesure en roulant (batterie indiquée aux bornes)";
  $("ev-conso-utiliser-btn")?.addEventListener("click", () => {
    $("ev-profil-conso").value = mesure.kwh_100km;
    toast("Valeur mesurée reprise : touche « Enregistrer » pour la garder");
  });
}

function rendreReglagesProfil() {
  const profil = obtenirProfilVehicule();
  const reglages = lireReglages();
  $("ev-reglage-domicile").value = reglages.adresse_domicile || "";
  $("ev-reglage-annonce").checked = !!reglages.annonce_vocale;
  $("ev-reglage-carte3d").value = reglages.carte_3d || "libre";
  $("ev-reglage-relief").checked = reglages.relief_3d === true;
  $("ev-reglage-jour-nuit").checked = reglages.jour_nuit_auto !== false;
  $("ev-reglage-mode-voiture").checked = reglages.mode_voiture === true;
  $("ev-reglage-taille-bandeau").value = reglages.taille_bandeau === "grand" ? "grand" : "compact";
  $("ev-reglage-zoom-renforce").checked = reglages.zoom_renforce !== false;
  $("ev-reglage-voix").checked = reglages.voix_guidage !== false;
  $("ev-reglage-voix-voies").checked = reglages.voix_voies !== false;
  $("ev-reglage-voix-travaux").checked = reglages.voix_travaux !== false;
  $("ev-reglage-voix-bornes").checked = reglages.voix_bornes !== false;
  $("ev-reglage-bip").checked = reglages.bip_vitesse !== false;
  $("ev-reglage-fenetre-voies").checked = reglages.fenetre_voies !== false;
  $("ev-reglage-vue-carrefour").checked = reglages.vue_carrefour !== false;
  $("ev-reglage-icone").value = reglages.icone_voiture || "fleche_bleue";
  $("ev-reglage-parking-arrivee").checked = reglages.parking_arrivee !== false;
  $("ev-reglage-privilegier-abos").checked = reglages.privilegier_abonnements !== false;
  $("ev-reglage-meteo-route").checked = reglages.meteo_route !== false;
  $("ev-reglage-aires").checked = reglages.aires_autoroute !== false;
  $("ev-reglage-feux").checked = reglages.feux !== false;
  $("ev-reglage-zones-danger").checked = reglages.zones_danger !== false;

  const { tomtom, openChargeMap } = getApiKeys();
  $("ev-cle-tomtom").value = tomtom || "";
  $("ev-cle-ocm").value = openChargeMap || "";

  const types = typesDeCharge(profil);
  for (const option of $("ev-calc-type-select").options) {
    const t = types[option.value];
    if (t) option.textContent = `${t.label} — ${t.puissance_kw} kW`;
  }
}

// Explique un refus TomTom en clair (les codes seuls ne parlent à personne).
function expliquerRefusTomTom(r) {
  if (r.ok) return "fonctionne";
  const m = (r.message || "").toLowerCase();
  if (r.statut === 401) return "clé inconnue : vérifie qu'elle est bien recopiée";
  if (/qps|rate|limit|quota|over/.test(m)) return `quota TomTom dépassé (« ${r.message} ») : réessaie plus tard`;
  if (r.statut === 403) return `refusé par TomTom (« ${r.message || "accès interdit"} ») : sur developer.tomtom.com, vérifie que ce service est coché pour ta clé`;
  if (r.statut === 0) return r.message;
  return `erreur HTTP ${r.statut}${r.message ? ` (« ${r.message} »)` : ""}`;
}

function cablerProfil() {
  cablerZonesEvitees(afficherVue);
  $("ev-export-donnees-btn").addEventListener("click", exporterSauvegarde);
  $("ev-lien-sauvegarde-btn").addEventListener("click", envoyerLienRestauration);
  $("ev-installer-btn").addEventListener("click", installerAppli);
  majInfoLien();
  majBoutonInstallation();
  $("ev-revoir-accueil-btn").addEventListener("click", () => afficherAccueil(afficherVue));
  cablerAbonnements();
  $("ev-import-donnees-btn").addEventListener("click", () => $("ev-import-donnees-fichier").click());
  $("ev-import-donnees-fichier").addEventListener("change", (e) => {
    const fichier = e.target.files?.[0];
    e.target.value = "";
    if (fichier && confirm("Remplacer toutes les données de ce téléphone par celles de la sauvegarde ?")) importerSauvegarde(fichier);
  });
  $("ev-tester-tomtom-btn").addEventListener("click", async () => {
    const cle = $("ev-cle-tomtom").value.trim() || getApiKeys().tomtom;
    const zone = $("ev-tester-tomtom-resultat");
    zone.classList.remove("hidden");
    if (!cle) {
      zone.textContent = "Saisis d'abord ta clé TomTom.";
      return;
    }
    const bouton = $("ev-tester-tomtom-btn");
    bouton.disabled = true;
    zone.textContent = "⏳ Test en cours…";
    try {
      const resultats = await diagnostiquerCleTomTom(cle);
      zone.innerHTML = resultats.map((r) => `<div>${r.ok ? "✅" : "❌"} <strong>${escapeHtml(r.service)}</strong> : ${escapeHtml(expliquerRefusTomTom(r))}</div>`).join("");
    } finally {
      bouton.disabled = false;
    }
  });
  $("ev-profil-save-btn").addEventListener("click", () => {
    const avaitCleOcm = !!getApiKeys().openChargeMap;
    const connecteurs = $("ev-profil-connecteurs").value.split(",").map((s) => s.trim()).filter(Boolean);
    definirProfilVehicule({
      nom: $("ev-profil-nom").value.trim() || undefined,
      capacite_kwh: nombreOuUndefined($("ev-profil-capacite").value),
      consommation_kwh_100km: nombreOuUndefined($("ev-profil-conso").value),
      puissance_ac_kw: nombreOuUndefined($("ev-profil-ac").value),
      puissance_dc_kw: nombreOuUndefined($("ev-profil-dc").value),
      puissance_domicile_kw: nombreOuUndefined($("ev-profil-domicile").value),
      prix_hc_eur_kwh: nombreOuUndefined($("ev-profil-prix-hc").value),
      prix_hp_eur_kwh: nombreOuUndefined($("ev-profil-prix-hp").value),
      part_hc_pct: nombreOuUndefined($("ev-profil-part-hc").value),
      connecteurs_acceptes: connecteurs.length ? connecteurs : undefined,
      saison: $("ev-profil-saison").value,
    });
    sauverReglages({
      adresse_domicile: $("ev-reglage-domicile").value.trim(),
      annonce_vocale: $("ev-reglage-annonce").checked,
      carte_3d: $("ev-reglage-carte3d").value,
      relief_3d: $("ev-reglage-relief").checked,
      jour_nuit_auto: $("ev-reglage-jour-nuit").checked,
      mode_voiture: $("ev-reglage-mode-voiture").checked,
      taille_bandeau: $("ev-reglage-taille-bandeau").value,
      zoom_renforce: $("ev-reglage-zoom-renforce").checked,
      voix_guidage: $("ev-reglage-voix").checked,
      voix_voies: $("ev-reglage-voix-voies").checked,
      voix_travaux: $("ev-reglage-voix-travaux").checked,
      voix_bornes: $("ev-reglage-voix-bornes").checked,
      bip_vitesse: $("ev-reglage-bip").checked,
      fenetre_voies: $("ev-reglage-fenetre-voies").checked,
      vue_carrefour: $("ev-reglage-vue-carrefour").checked,
      icone_voiture: $("ev-reglage-icone").value,
      parking_arrivee: $("ev-reglage-parking-arrivee").checked,
      privilegier_abonnements: $("ev-reglage-privilegier-abos").checked,
      meteo_route: $("ev-reglage-meteo-route").checked,
      aires_autoroute: $("ev-reglage-aires").checked,
      feux: $("ev-reglage-feux").checked,
      zones_danger: $("ev-reglage-zones-danger").checked,
    });
    const ancienneCleTomTom = getApiKeys().tomtom;
    setApiKeys({ tomtom: $("ev-cle-tomtom").value.trim(), openChargeMap: $("ev-cle-ocm").value.trim() });
    if (getApiKeys().tomtom !== ancienneCleTomTom) rechargerFond();
    rendreProfil();
    majBandeauCles();
    toast("✅ Profil et réglages enregistrés");
    if (!avaitCleOcm && getApiKeys().openChargeMap) {
      derniereZone = null;
      chargerBornesZone(true);
    }
  });
}

// ── Démarrage ──────────────────────────────────────────────────────────────

// Raccourcis de l'icône de l'appli (appui long) : ?action=maison, bornes, voiture.
export function executerAction(action) {
  if (action === "maison") {
    if (!lireReglages().adresse_domicile) {
      afficherVue("profil");
      return toast("🏠 Indique d'abord l'adresse du domicile dans le Profil.");
    }
    afficherVue("trajet");
    $("ev-depart-input").value = "Ma position";
    $("ev-destination-input").value = "Chez moi";
    lancerTrajet();
  } else if (action === "bornes") {
    afficherVue("bornes");
    localiser();
  } else if (action === "voiture") {
    afficherVue("bornes");
    $("ev-voiture-chip")?.click();
  }
}

export function initialiserUI() {
  initCarte("ev-carte", { fondInitial: lireReglages().fond_carte || fondParDefaut(), onDeplacement: surDeplacementCarte });
  cablerTheme();
  cablerFeuille();
  cablerNavigation();
  cablerCarte();
  cablerFiche();
  cablerFormulaire();
  cablerResultat();
  cablerFrise();
  cablerFavoris();
  cablerOutils();
  cablerUrgence();
  cablerProfil();

  chargerPrefs();
  rendreProfil();
  majBandeauCles();
  appliquerTheme();
  afficherVue("bornes", { etat: "bas", historique: false });
  positionDeDepart();
  proposerRepriseNavigation();
  // Nouveaux utilisateurs seulement (aucune clé encore saisie).
  if (!lireReglages().accueil_vu && !getApiKeys().tomtom && !getApiKeys().openChargeMap) afficherAccueil(afficherVue);
}

