// Journal des recharges (Menu › Outils) : bilan mensuel, ajout manuel.

import { $, toast, euros, nombre, nombreAffiche, nombreOuUndefined, hint, tuile } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { obtenirProfilVehicule, listerJournal, ajouterAuJournal, modifierJournal, retirerDuJournal, kmReelsParRecharge, consommationReelleSur } from "./storage.js";
import { rechargesDetecteesParJarvis } from "./relais.js";

function moisLisible(cle) {
  const [a, m] = cle.split("-").map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

// Km : ceux parcourus avec ces kWh, d'après la consommation du profil.
function bilanRecharges(entrees) {
  const consoVe = obtenirProfilVehicule().consommation_kwh_100km || 15;
  const kwh = entrees.reduce((s, e) => s + (e.kwh || 0), 0);
  const cout = entrees.reduce((s, e) => s + (e.cout_eur || 0), 0);
  const km = (kwh / consoVe) * 100;
  return { n: entrees.length, kwh, cout, km };
}

// Importe les recharges détectées par JARVIS via Bluelink depuis le relais
// (voir jarvis_bluelink_runtime.boucle_detection_recharge), en ignorant
// celles déjà présentes (dédupliquées par id_bluelink = ts_fin de JARVIS,
// en secondes). kWh estimé depuis le % de batterie avant/après et la
// capacité du profil -- JARVIS ne connaît pas la capacité de la batterie,
// c'est un réglage TrajetVE. Renvoie le nombre d'entrées importées.
// Demande explicite de l'utilisateur le 2026-10-25.
export async function synchroniserRechargesDetectees() {
  const recharges = await rechargesDetecteesParJarvis();
  if (!recharges.length) return 0;
  const dejaConnues = new Set(listerJournal().map((e) => e.id_bluelink).filter(Boolean));
  const capacite = obtenirProfilVehicule().capacite_kwh || 64;
  let importees = 0;
  for (const r of recharges) {
    if (!Number.isFinite(r.ts_fin) || dejaConnues.has(r.ts_fin)) continue;
    const pctDebut = Number.isFinite(r.batterie_pct_debut) ? r.batterie_pct_debut : null;
    const pctFin = Number.isFinite(r.batterie_pct_fin) ? r.batterie_pct_fin : null;
    const kwh = pctDebut !== null && pctFin !== null && pctFin > pctDebut ? ((pctFin - pctDebut) / 100) * capacite : 0;
    ajouterAuJournal({
      ts: Math.round(r.ts_fin * 1000),
      lieu: "Détectée automatiquement",
      kwh: Math.round(kwh * 100) / 100,
      cout_eur: 0,
      source: "bluelink",
      kwh_estime: true,
      id_bluelink: r.ts_fin,
      odometre_km: Number.isFinite(r.odometre_km) ? r.odometre_km : null,
    });
    importees++;
  }
  return importees;
}

export function rendreJournal() {
  const journal = listerJournal();
  if (!journal.length) {
    $("ev-journal-bilan").innerHTML = hint("Aucune recharge enregistrée pour l'instant.");
    $("ev-journal-liste").innerHTML = "";
    return;
  }
  const parMois = new Map();
  for (const e of journal) {
    const d = new Date(e.ts);
    const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!parMois.has(cle)) parMois.set(cle, []);
    parMois.get(cle).push(e);
  }
  const lignes = [...parMois.entries()].slice(0, 6).map(([cle, entrees]) => {
    const b = bilanRecharges(entrees);
    return `<div class="ev-journal-mois"><strong>${escapeHtml(moisLisible(cle))}</strong><span>${b.n} recharge${b.n > 1 ? "s" : ""} · ${nombreAffiche(b.kwh, 1)} kWh · ${euros(b.cout)} · ~${nombreAffiche(b.km)} km</span></div>`;
  });
  const total = bilanRecharges(journal);
  // kWh/100 km réel : déduit des recharges Bluelink consécutives (odomètre
  // réel), bien plus fiable que l'estimation théorique ci-dessus -- affiché
  // seulement quand calculable (au moins 2 recharges Bluelink).
  const consoReelle = consommationReelleSur(journal);
  const tuileReelle = consoReelle !== null ? tuile("good", `${nombre(consoReelle, 1)} kWh/100 km`, "Consommation réelle") : "";
  $("ev-journal-bilan").innerHTML = `<div class="ev-tuiles">${tuile("cyan", `${nombreAffiche(total.kwh)} kWh`, "Énergie totale")}${tuile("violet", euros(total.cout), "Dépensé")}${tuile("good", `~${nombreAffiche(total.km)} km`, "Parcourus avec (estimé)")}${tuileReelle}</div>${lignes.join("")}`;
  const kmReels = kmReelsParRecharge(journal);
  $("ev-journal-liste").innerHTML = journal
    .slice(0, 15)
    .map((e) => {
      const km = kmReels.get(e.id);
      return `<div class="ev-journal-ligne" data-editer="${escapeHtml(e.id)}"><span>${new Date(e.ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${escapeHtml(e.lieu || "Recharge")}</span><span>${nombre(e.kwh, 1)} kWh${e.kwh_estime ? " (estimé)" : ""} · ${euros(e.cout_eur || 0)}${e.prix_estime ? " (estimé)" : ""}${km !== undefined ? ` · ${nombre(km)} km réels` : ""}</span><button type="button" class="ev-lien" data-journal="${escapeHtml(e.id)}" title="Supprimer">✕</button></div>`;
    })
    .join("");
  $("ev-journal-liste")
    .querySelectorAll("[data-journal]")
    .forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // ne doit pas aussi déclencher l'édition de la ligne
        retirerDuJournal(btn.dataset.journal);
        if (idEnEdition === btn.dataset.journal) annulerEditionJournal();
        rendreJournal();
      }),
    );
  $("ev-journal-liste")
    .querySelectorAll("[data-editer]")
    .forEach((ligne) => ligne.addEventListener("click", () => demarrerEditionJournal(ligne.dataset.editer)));
}

// Modification d'une recharge existante en touchant sa ligne -- demande
// explicite de l'utilisateur le 2026-10-26. Réutilise le même formulaire
// que l'ajout manuel (pré-rempli), pour ne pas dupliquer l'interface.
let idEnEdition = null;

// yyyy-MM-dd en heure LOCALE (pas toISOString, qui bascule en UTC et peut
// décaler la date d'un jour près de minuit).
function dateVersValeurChamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function demarrerEditionJournal(id) {
  const entree = listerJournal().find((e) => e.id === id);
  if (!entree) return;
  idEnEdition = id;
  $("ev-journal-date").value = dateVersValeurChamp(entree.ts);
  $("ev-journal-lieu").value = entree.lieu || "";
  $("ev-journal-kwh").value = entree.kwh ?? "";
  $("ev-journal-cout").value = entree.cout_eur ?? "";
  $("ev-journal-ajouter-details").open = true;
  $("ev-journal-ajouter-titre").textContent = "✏️ Modifier cette recharge";
  $("ev-journal-ajouter-btn").textContent = "Enregistrer la modification";
  $("ev-journal-annuler-btn").classList.remove("hidden");
  $("ev-journal-ajouter-details").scrollIntoView({ behavior: "smooth", block: "center" });
}

function annulerEditionJournal() {
  idEnEdition = null;
  for (const id of ["ev-journal-date", "ev-journal-lieu", "ev-journal-kwh", "ev-journal-cout"]) $(id).value = "";
  $("ev-journal-ajouter-titre").textContent = "➕ Ajouter une recharge à la main";
  $("ev-journal-ajouter-btn").textContent = "Ajouter";
  $("ev-journal-annuler-btn").classList.add("hidden");
}

// Pour Excel en français : point-virgule (la virgule sert de séparateur
// décimal), nombres avec virgule comme partout ailleurs dans l'appli.
function champCsv(valeur) {
  const t = String(valeur ?? "");
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// Note de frais / suivi perso -- demande explicite de l'utilisateur le
// 2026-10-11 : les statistiques existaient déjà, rien pour les sortir de
// l'appli (reimbursement professionnel, comptabilité personnelle...).
// Partie pure (testable) : construit le texte, sans toucher au DOM.
export function construireCsvJournal(journal) {
  const trie = [...journal].sort((a, b) => a.ts - b.ts);
  const lignes = [
    ["Date", "Lieu", "Énergie (kWh)", "Coût (€)", "Source"].join(";"),
    ...trie.map((e) =>
      [
        new Date(e.ts).toLocaleDateString("fr-FR"),
        champCsv(e.lieu || "Recharge"),
        nombre(e.kwh, 2),
        nombre(e.cout_eur || 0, 2),
        { manuel: "Ajout manuel", bluelink: "Détection automatique" }[e.source] || "Navigation",
      ].join(";"),
    ),
  ];
  const b = bilanRecharges(trie);
  lignes.push(["Total", "", nombre(b.kwh, 2), nombre(b.cout, 2), `${b.n} recharge${b.n > 1 ? "s" : ""}`].join(";"));
  // BOM UTF-8 : Excel (Windows) affiche sinon les accents mal interprétés.
  return "﻿" + lignes.join("\r\n");
}

async function exporterJournalCsv() {
  const journal = listerJournal();
  if (!journal.length) return toast("Aucune recharge à exporter pour l'instant.");
  const csv = construireCsvJournal(journal);
  const fichier = new File([csv], `trajetve-recharges-${new Date().toISOString().slice(0, 10)}.csv`, { type: "text/csv" });
  if (navigator.canShare?.({ files: [fichier] })) {
    try {
      await navigator.share({ files: [fichier], title: "Mes recharges TrajetVE" });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(fichier);
  const a = document.createElement("a");
  a.href = url;
  a.download = fichier.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast("📄 Fichier téléchargé");
}

export function cablerJournal() {
  $("ev-journal-ajouter-btn").addEventListener("click", () => {
    const kwh = nombreOuUndefined($("ev-journal-kwh").value);
    if (!kwh || kwh <= 0) return toast("Indique l'énergie rechargée (kWh).");
    const lieu = $("ev-journal-lieu").value.trim() || "Recharge";
    const cout_eur = nombreOuUndefined($("ev-journal-cout").value) ?? 0;
    // Date optionnelle (pour corriger une recharge mal datée, ou en
    // ajouter une à une date passée) -- demande explicite de l'utilisateur
    // le 2026-10-26. Sans date choisie : date du jour, comme avant.
    const dateChoisie = $("ev-journal-date").value;
    const ts = dateChoisie ? new Date(dateChoisie).getTime() : Date.now();
    if (idEnEdition) {
      modifierJournal(idEnEdition, { lieu, kwh, cout_eur, ts });
      toast("✅ Recharge modifiée");
      annulerEditionJournal();
    } else {
      ajouterAuJournal({ lieu, kwh, cout_eur, source: "manuel", ts });
      for (const id of ["ev-journal-date", "ev-journal-lieu", "ev-journal-kwh", "ev-journal-cout"]) $(id).value = "";
      toast("✅ Recharge ajoutée au journal");
    }
    rendreJournal();
  });
  $("ev-journal-annuler-btn").addEventListener("click", annulerEditionJournal);
  $("ev-journal-exporter-btn").addEventListener("click", exporterJournalCsv);
}
