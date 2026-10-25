// Onglet Outils › 📊 Mes statistiques : tuiles de chiffres (pas de
// graphique : chaque valeur se lit directement).

import { $, toast, euros, nombre, nombreOuUndefined, tuile } from "./ui-commun.js";
import { escapeHtml } from "./util.js";
import { listerJournal, listerTrajetsFaits, ajouterTrajetFait, retirerTrajetFait } from "./storage.js";
import { statistiques } from "./statistiques.js";

let periode = "mois";

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
