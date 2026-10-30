// Carnet d'entretien (Menu › Outils) : historique des interventions, coût
// réel par km (recharge + entretien). Même gabarit que ui-journal.js.
// Demande explicite de l'utilisateur le 2026-10-30.

import { $, toast, euros, nombre, nombreAffiche, nombreOuUndefined, hint, tuile } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { listerEntretien, ajouterEntretien, modifierEntretien, retirerEntretien, coutParKm, listerJournal, definirProfilVehicule } from "./storage.js";
import { relaisConfigure, lireEtatVehiculeRelais } from "./relais.js";

const TYPES_PREREGLES = ["Vidange", "Pneus", "Plaquettes de frein", "Révision", "Assurance", "Contrôle technique"];

// Dernier kilométrage réel connu (recharges Bluelink, odomètre du
// véhicule) -- affiché seulement en indication quand le coût au km n'est
// pas calculable, pour aider à remplir le profil sans rien écrire soi-même.
function dernierKmReelConnu() {
  const bluelink = listerJournal()
    .filter((e) => e.source === "bluelink" && Number.isFinite(e.odometre_km))
    .sort((a, b) => b.ts - a.ts);
  return bluelink[0]?.odometre_km ?? null;
}

export function rendreEntretien() {
  const entretien = listerEntretien();
  const cout = coutParKm();
  const coutTotal = entretien.reduce((s, e) => s + (e.cout_eur || 0), 0);
  const tuiles = [tuile("violet", euros(coutTotal), "Dépensé en entretien")];
  if (cout) {
    tuiles.push(tuile("good", `${nombre(cout.eur_par_km, 3)} €/km`, `Coût réel (${nombreAffiche(cout.distance_km)} km)`));
  }
  $("ev-entretien-bilan").innerHTML = `<div class="ev-tuiles">${tuiles.join("")}</div>${
    cout ? "" : hint(`Coût au km non calculable : renseignez le kilométrage dans Profil › Infos du véhicule.${(() => { const k = dernierKmReelConnu(); return k ? ` Dernier relevé réel connu : ${nombreAffiche(k)} km.` : ""; })()}`)
  }`;
  $("ev-entretien-km-relais-btn")?.classList.toggle("hidden", !(!cout && relaisConfigure()));

  if (!entretien.length) {
    $("ev-entretien-liste").innerHTML = hint("Aucun entretien enregistré pour l'instant.");
    return;
  }
  $("ev-entretien-liste").innerHTML = entretien
    .slice(0, 20)
    .map((e) => {
      const echeance = [e.prochaine_date_ts ? `prochaine fois : ${new Date(e.prochaine_date_ts).toLocaleDateString("fr-FR")}` : "", e.prochain_km ? `${nombreAffiche(e.prochain_km)} km` : ""].filter(Boolean).join(" · ");
      return `<div class="ev-journal-ligne" data-editer="${escapeHtml(e.id)}"><span>${new Date(e.date_ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })} · ${escapeHtml(e.type || "Entretien")}</span><span>${euros(e.cout_eur || 0)}${e.km ? ` · ${nombreAffiche(e.km)} km` : ""}${echeance ? ` · ↻ ${escapeHtml(echeance)}` : ""}</span><button type="button" class="ev-lien" data-entretien="${escapeHtml(e.id)}" title="Supprimer">✕</button></div>`;
    })
    .join("");
  $("ev-entretien-liste")
    .querySelectorAll("[data-entretien]")
    .forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        retirerEntretien(btn.dataset.entretien);
        if (idEnEdition === btn.dataset.entretien) annulerEditionEntretien();
        rendreEntretien();
      }),
    );
  $("ev-entretien-liste")
    .querySelectorAll("[data-editer]")
    .forEach((ligne) => ligne.addEventListener("click", () => demarrerEditionEntretien(ligne.dataset.editer)));
}

let idEnEdition = null;

function dateVersValeurChamp(ts) {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function majTypeAutre() {
  $("ev-entretien-type-autre-champ").classList.toggle("hidden", $("ev-entretien-type").value !== "Autre");
}

function demarrerEditionEntretien(id) {
  const entree = listerEntretien().find((e) => e.id === id);
  if (!entree) return;
  idEnEdition = id;
  $("ev-entretien-type").value = TYPES_PREREGLES.includes(entree.type) ? entree.type : "Autre";
  $("ev-entretien-type-autre").value = TYPES_PREREGLES.includes(entree.type) ? "" : entree.type || "";
  majTypeAutre();
  $("ev-entretien-date").value = dateVersValeurChamp(entree.date_ts);
  $("ev-entretien-km").value = entree.km ?? "";
  $("ev-entretien-cout").value = entree.cout_eur ?? "";
  $("ev-entretien-prochaine-date").value = dateVersValeurChamp(entree.prochaine_date_ts);
  $("ev-entretien-prochain-km").value = entree.prochain_km ?? "";
  $("ev-entretien-notes").value = entree.notes || "";
  $("ev-entretien-ajouter-details").open = true;
  $("ev-entretien-ajouter-titre").textContent = "✏️ Modifier cet entretien";
  $("ev-entretien-ajouter-btn").textContent = "Enregistrer la modification";
  $("ev-entretien-annuler-btn").classList.remove("hidden");
  $("ev-entretien-ajouter-details").scrollIntoView({ behavior: "smooth", block: "center" });
}

const CHAMPS_FORM = ["ev-entretien-date", "ev-entretien-km", "ev-entretien-cout", "ev-entretien-prochaine-date", "ev-entretien-prochain-km", "ev-entretien-notes", "ev-entretien-type-autre"];

function annulerEditionEntretien() {
  idEnEdition = null;
  for (const id of CHAMPS_FORM) $(id).value = "";
  $("ev-entretien-type").value = TYPES_PREREGLES[0];
  majTypeAutre();
  $("ev-entretien-ajouter-titre").textContent = "➕ Ajouter un entretien";
  $("ev-entretien-ajouter-btn").textContent = "Ajouter";
  $("ev-entretien-annuler-btn").classList.add("hidden");
}

function champCsv(valeur) {
  const t = String(valeur ?? "");
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// Même principe que construireCsvJournal (ui-journal.js) : partie pure,
// testable sans DOM.
export function construireCsvEntretien(entretien) {
  const trie = [...entretien].sort((a, b) => a.date_ts - b.date_ts);
  const lignes = [
    ["Date", "Type", "Km", "Coût (€)", "Prochaine échéance (date)", "Prochaine échéance (km)", "Notes"].join(";"),
    ...trie.map((e) =>
      [
        new Date(e.date_ts).toLocaleDateString("fr-FR"),
        champCsv(e.type || "Entretien"),
        e.km ? nombre(e.km) : "",
        nombre(e.cout_eur || 0, 2),
        e.prochaine_date_ts ? new Date(e.prochaine_date_ts).toLocaleDateString("fr-FR") : "",
        e.prochain_km ? nombre(e.prochain_km) : "",
        champCsv(e.notes || ""),
      ].join(";"),
    ),
  ];
  const total = trie.reduce((s, e) => s + (e.cout_eur || 0), 0);
  lignes.push(["Total", "", "", nombre(total, 2), "", "", `${trie.length} entretien${trie.length > 1 ? "s" : ""}`].join(";"));
  return "﻿" + lignes.join("\r\n");
}

async function exporterEntretienCsv() {
  const entretien = listerEntretien();
  if (!entretien.length) return toast("Aucun entretien à exporter pour l'instant.");
  const csv = construireCsvEntretien(entretien);
  const fichier = new File([csv], `trajetve-entretien-${new Date().toISOString().slice(0, 10)}.csv`, { type: "text/csv" });
  if (navigator.canShare?.({ files: [fichier] })) {
    try {
      await navigator.share({ files: [fichier], title: "Mon carnet d'entretien TrajetVE" });
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

export function cablerEntretien() {
  for (const t of TYPES_PREREGLES) $("ev-entretien-type").insertAdjacentHTML("beforeend", `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
  $("ev-entretien-type").insertAdjacentHTML("beforeend", `<option value="Autre">Autre</option>`);
  $("ev-entretien-type").addEventListener("change", majTypeAutre);
  majTypeAutre();

  $("ev-entretien-ajouter-btn").addEventListener("click", () => {
    const cout_eur = nombreOuUndefined($("ev-entretien-cout").value);
    if (cout_eur === undefined || cout_eur < 0) return toast("Indique le coût (€).");
    const type = $("ev-entretien-type").value === "Autre" ? $("ev-entretien-type-autre").value.trim() || "Autre" : $("ev-entretien-type").value;
    const dateChoisie = $("ev-entretien-date").value;
    const date_ts = dateChoisie ? new Date(dateChoisie).getTime() : Date.now();
    const prochaineDateChoisie = $("ev-entretien-prochaine-date").value;
    const entree = {
      type,
      date_ts,
      cout_eur,
      km: nombreOuUndefined($("ev-entretien-km").value),
      prochaine_date_ts: prochaineDateChoisie ? new Date(prochaineDateChoisie).getTime() : undefined,
      prochain_km: nombreOuUndefined($("ev-entretien-prochain-km").value),
      notes: $("ev-entretien-notes").value.trim() || undefined,
    };
    if (idEnEdition) {
      modifierEntretien(idEnEdition, entree);
      toast("✅ Entretien modifié");
    } else {
      ajouterEntretien(entree);
      toast("✅ Entretien ajouté");
    }
    annulerEditionEntretien();
    rendreEntretien();
  });
  $("ev-entretien-annuler-btn").addEventListener("click", annulerEditionEntretien);
  $("ev-entretien-exporter-btn").addEventListener("click", exporterEntretienCsv);

  // Préremplit le kilométrage actuel avec le vrai relevé du relais (Pleos),
  // bien plus à jour que les seules recharges Bluelink -- un tap, jamais
  // automatique/silencieux. Demande explicite de l'utilisateur le 2026-10-30.
  $("ev-entretien-km-relais-btn")?.addEventListener("click", async () => {
    const btn = $("ev-entretien-km-relais-btn");
    btn.disabled = true;
    btn.textContent = "🔗 Lecture en cours…";
    const etat = await lireEtatVehiculeRelais();
    btn.disabled = false;
    btn.textContent = "🔗 Utiliser le relevé réel du relais";
    if (!etat || !Number.isFinite(etat.odometre_km)) return toast("⚠️ Kilométrage indisponible pour l'instant.");
    definirProfilVehicule({ kilometrage_actuel_km: etat.odometre_km });
    toast(`🔧 Kilométrage actuel mis à jour : ${nombreAffiche(etat.odometre_km)} km`);
    rendreEntretien();
  });
}
