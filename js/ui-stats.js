// Onglet Outils › 📊 Mes statistiques : tuiles de chiffres, plus deux
// graphiques simples (km par jour, répartition par type de route --
// demande explicite de l'utilisateur le 2026-10-26).

import { $, toast, euros, nombre, nombreOuUndefined, tuile } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { listerJournal, listerTrajetsFaits, ajouterTrajetFait, retirerTrajetFait } from "./storage.js";
import { statistiques } from "./statistiques.js";
import { relaisConfigure, lireEtatVehiculeRelais } from "./relais.js";

let periode = "mois";

// État réel de la Kona (batterie, autonomie, compteur réel, verrouillage,
// charge, climatisation...) -- lu via le relais JARVIS (Pleos en priorité,
// voir jarvis_bluelink_runtime.py). Demande explicite de l'utilisateur le
// 2026-10-26 : « avoir vraiment un suivi de la Kona », avec le maximum
// d'informations disponibles. Chaque champ n'apparaît que s'il est
// réellement transmis par le véhicule (certains, comme la pression des
// pneus, dépendent de la finition/des capteurs -- pas une erreur s'ils
// manquent).
function couleurBatterie(pct) {
  return pct >= 20 ? "good" : pct >= 10 ? "warn" : "bad";
}

function texteDepuis(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(diffMin)) return "";
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  return `il y a ${Math.round(diffH / 24)} j`;
}

export function rendreEtatKona(etat) {
  const conteneur = $("ev-kona-etat");
  if (!conteneur) return;
  if (!relaisConfigure()) {
    conteneur.innerHTML = `<div class="ev-hint">Configure l'URL du relais dans 🚗 Profil pour voir ici l'état réel de la Kona (batterie, verrouillage, charge...).</div>`;
    return;
  }
  if (!etat || !etat.ok) {
    conteneur.innerHTML = `<div class="ev-hint">État indisponible pour l'instant (JARVIS doit avoir publié un relevé récent, moins de 15 min).</div>`;
    return;
  }
  const t = [];
  if (Number.isFinite(etat.batterie_pct)) t.push(tuile(couleurBatterie(etat.batterie_pct), `${Math.round(etat.batterie_pct)} %`, "Batterie"));
  if (Number.isFinite(etat.autonomie_km)) t.push(tuile("cyan", `${nombre(etat.autonomie_km)} km`, "Autonomie"));
  if (Number.isFinite(etat.odometre_km)) t.push(tuile("violet", `${nombre(etat.odometre_km)} km`, "Compteur réel"));
  if (etat.en_charge) t.push(tuile("good", "⚡ En charge", Number.isFinite(etat.minutes_restantes_charge) && etat.minutes_restantes_charge > 0 ? `${etat.minutes_restantes_charge} min restantes` : "Charge en cours"));
  else if (etat.branche) t.push(tuile("warn", "🔌 Branchée", "Pas en charge"));
  if (typeof etat.verrouille === "boolean") t.push(tuile(etat.verrouille ? "good" : "warn", etat.verrouille ? "🔒 Verrouillée" : "🔓 Déverrouillée", "Portes"));
  if (etat.climatisation_active) t.push(tuile("warn", "❄️ Active", "Climatisation"));
  if (Number.isFinite(etat.temperature_exterieure_c)) t.push(tuile("cyan", `${Math.round(etat.temperature_exterieure_c)} °C`, "Température extérieure"));
  if (etat.capot_ouvert || etat.coffre_ouvert) {
    const quoi = [etat.capot_ouvert ? "capot" : null, etat.coffre_ouvert ? "coffre" : null].filter(Boolean).join(" + ");
    t.push(tuile("bad", "⚠️ Ouvert", quoi.charAt(0).toUpperCase() + quoi.slice(1)));
  }
  if (etat.avertissements?.length) t.push(tuile("bad", `${etat.avertissements.length}`, `Avertissement${etat.avertissements.length > 1 ? "s" : ""}`));
  const maj = etat.derniere_maj_position ? texteDepuis(etat.derniere_maj_position) : "";
  conteneur.innerHTML = t.length
    ? `<div class="ev-tuiles">${t.join("")}</div><div class="ev-hint">${etat.source === "pleos" ? "Donnée officielle Pleos" : "Donnée Bluelink"}${maj ? " · position " + maj : ""}</div>`
    : `<div class="ev-hint">Aucune donnée exploitable pour l'instant.</div>`;
}

let derniereLectureEtatKona = 0;
export async function rafraichirEtatKona({ forcer = false } = {}) {
  if (!relaisConfigure()) return rendreEtatKona(null);
  if (!forcer && Date.now() - derniereLectureEtatKona < 60000) return;
  derniereLectureEtatKona = Date.now();
  rendreEtatKona(await lireEtatVehiculeRelais());
}

// Tuiles km/kWh/€ par 100km/CO2 : dérivées des trajets guidés + ajoutés à
// la main (voir cablerTrajets ci-dessous) -- un tap ouvre cette liste. La
// tuile recharges (orange) ouvre plutôt le Journal des recharges, seule
// vraie source de ces données. Demande explicite de l'utilisateur le
// 2026-10-25 : pouvoir voir le détail derrière chaque tuile.
export function rendreStats() {
  for (const b of document.querySelectorAll("[data-periode]")) b.classList.toggle("active", b.dataset.periode === periode);
  const s = statistiques(listerTrajetsFaits(), listerJournal(), periode, Date.now());
  $("ev-stats-tuiles").innerHTML = s.trajets || s.recharges
    ? [
        tuile("good", `${nombre(s.km)} km`, `${s.trajets} trajet${s.trajets > 1 ? "s" : ""} guidé${s.trajets > 1 ? "s" : ""}`, "trajets"),
        tuile("good", `${nombre(s.kwh)} kWh`, "Consommés (estimé)", "trajets"),
        tuile("warn", euros(s.cout_recharges), `${s.recharges} recharge${s.recharges > 1 ? "s" : ""} · ${nombre(s.kwh_recharges)} kWh`, "recharges"),
        tuile("good", `${nombre(s.cout_km * 100, 1)} €`, "Pour 100 km", "trajets"),
        tuile("good", `${nombre(s.co2_evite_kg)} kg`, "De CO₂ évités (~)", "trajets"),
      ].join("")
    : `<div class="ev-hint">Rien encore sur cette période : les trajets guidés et le journal des recharges alimentent ces chiffres.</div>`;
  rendreKmJournalier(listerTrajetsFaits());
  rendreRepartitionRoutes(listerTrajetsFaits());
}

// Km par jour, 14 derniers jours (même sans trajet un jour donné -- barre
// vide, pour voir le rythme réel). Toujours sur les 14 derniers jours,
// indépendamment du filtre Ce mois/Cette année/Depuis le début ci-dessus :
// c'est une vue "récente", pas une période choisie. Demande explicite de
// l'utilisateur le 2026-10-26.
function rendreKmJournalier(trajets) {
  const conteneur = $("ev-stats-km-jour");
  if (!conteneur) return;
  const parJour = new Map();
  for (const t of trajets) {
    const d = new Date(t.date);
    const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    parJour.set(cle, (parJour.get(cle) || 0) + (t.km || 0));
  }
  const jours = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    jours.push({ km: parJour.get(cle) || 0, label: d.toLocaleDateString("fr-FR", { weekday: "narrow" }) });
  }
  const max = Math.max(...jours.map((j) => j.km), 1);
  conteneur.innerHTML = `<div class="ev-graphe-jours">${jours
    .map(
      (j) =>
        `<div class="ev-barre-jour" title="${nombre(j.km, 1)} km"><span class="ev-barre-jour-remplissage" style="height:${Math.max(2, Math.round((j.km / max) * 100))}%"></span><span class="ev-barre-jour-label">${escapeHtml(j.label)}</span></div>`,
    )
    .join("")}</div>`;
}

// Répartition par type de route (autoroute/voie express/nationale-
// départementale/ville), cumulée sur tous les trajets guidés par TrajetVE
// depuis le 2026-10-26 (seuls à connaître le type de route parcouru --
// contrairement aux trajets détectés par Hyundai/Pleos, qui ne donnent que
// la distance totale). Moyenne volontairement grossière, sans correction
// météo -- demande explicite de l'utilisateur.
const CATEGORIES_ROUTE = [
  ["autoroute", "Autoroute", "var(--violet-texte)"],
  ["voie_express", "Voie express", "var(--cyan)"],
  ["nationale_departementale", "Nationale/départ.", "var(--vert-vif)"],
  ["autre", "Ville / autre", "var(--texte-faible)"],
];

function rendreRepartitionRoutes(trajets) {
  const conteneur = $("ev-stats-routes");
  if (!conteneur) return;
  const total = { autoroute: 0, voie_express: 0, nationale_departementale: 0, autre: 0 };
  let uneDonnee = false;
  for (const t of trajets) {
    if (!t.repartition_km) continue;
    uneDonnee = true;
    for (const c in total) total[c] += t.repartition_km[c] || 0;
  }
  if (!uneDonnee) {
    conteneur.innerHTML = `<div class="ev-hint">Se remplit au fil de tes trajets guidés par TrajetVE (pas ceux suivis seulement par Hyundai, qui ne précisent pas le type de route).</div>`;
    return;
  }
  const max = Math.max(...Object.values(total), 1);
  conteneur.innerHTML = CATEGORIES_ROUTE.map(
    ([cle, label, couleur]) =>
      `<div class="ev-barre-ligne"><span>${label}</span><span class="ev-barre-piste"><span class="ev-barre-remplissage" style="width:${Math.round((total[cle] / max) * 100)}%;background:${couleur}"></span></span><span class="ev-barre-valeur">${nombre(total[cle])} km</span></div>`,
  ).join("");
}

export function rendreTrajets() {
  const trajets = listerTrajetsFaits();
  $("ev-trajets-liste").innerHTML = trajets.length
    ? trajets
        .slice(0, 15)
        .map(
          (t) =>
            `<div class="ev-journal-ligne"><span>${new Date(t.date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${escapeHtml(t.destination || "Trajet")}</span><span>${nombre(t.km)} km</span><button type="button" class="ev-lien" data-trajet="${t.date}" title="Supprimer">✕</button></div>`,
        )
        .join("")
    : `<div class="ev-hint">Aucun trajet pour l'instant.</div>`;
}

export function cablerStats(ouvrirBloc) {
  for (const b of document.querySelectorAll("[data-periode]")) {
    b.addEventListener("click", () => {
      periode = b.dataset.periode;
      rendreStats();
    });
  }
  $("ev-stats-tuiles").addEventListener("click", (e) => {
    const t = e.target.closest(".ev-tuile");
    if (!t) return;
    if (t.dataset.cible === "recharges") return ouvrirBloc?.("ev-bloc-journal");
    const details = $("ev-trajets-details");
    details.open = true;
    details.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("ev-trajet-manuel-ajouter-btn").addEventListener("click", () => {
    const km = nombreOuUndefined($("ev-trajet-manuel-km").value);
    if (!km || km <= 0) return toast("Indique les km parcourus.");
    const dateChoisie = $("ev-trajet-manuel-date").value;
    ajouterTrajetFait({
      date: dateChoisie ? new Date(dateChoisie).getTime() : Date.now(),
      km,
      destination: $("ev-trajet-manuel-destination").value.trim() || "",
    });
    for (const id of ["ev-trajet-manuel-date", "ev-trajet-manuel-km", "ev-trajet-manuel-destination"]) $(id).value = "";
    toast("✅ Trajet ajouté");
    rendreTrajets();
    rendreStats();
  });
  $("ev-trajets-liste").addEventListener("click", (e) => {
    const date = e.target.closest("[data-trajet]")?.dataset.trajet;
    if (date === undefined) return;
    retirerTrajetFait(Number(date));
    rendreTrajets();
    rendreStats();
  });
  rendreTrajets();
}
