import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const s = await import("../js/storage.js");

beforeEach(() => localStorage.clear());

test("sauvegarde : export puis import redonnent les mêmes données", () => {
  s.sauverReglages({ theme: "clair", mode_voiture: true });
  s.ajouterAuJournal({ lieu: "Domicile", kwh: 30, cout_eur: 6, source: "manuel" });
  localStorage.setItem("tve_navigation_en_cours", "{}"); // hors sauvegarde
  const fichier = JSON.parse(JSON.stringify(s.exporterDonnees()));
  assert.equal(Object.keys(fichier.donnees).length, 2);
  localStorage.clear();
  assert.equal(s.importerDonnees(fichier), 2);
  assert.equal(s.lireReglages().theme, "clair");
  assert.equal(s.listerJournal()[0].lieu, "Domicile");
});

test("sauvegarde : un fichier étranger est refusé sans rien effacer", () => {
  s.sauverReglages({ theme: "sombre" });
  assert.throws(() => s.importerDonnees({ nimporte: "quoi" }), /pas une sauvegarde/);
  assert.equal(s.lireReglages().theme, "sombre");
});

test("journal : ajout, ordre et suppression", () => {
  s.ajouterAuJournal({ lieu: "A", kwh: 10, cout_eur: 4 });
  s.ajouterAuJournal({ lieu: "B", kwh: 20, cout_eur: 8 });
  const journal = s.listerJournal();
  assert.deepEqual(journal.map((e) => e.lieu), ["B", "A"]);
  s.retirerDuJournal(journal[0].id);
  assert.deepEqual(s.listerJournal().map((e) => e.lieu), ["A"]);
});

test("consommation mesurée : moyenne pondérée, mesures aberrantes ignorées", () => {
  assert.equal(s.enregistrerMesureConso(30, 4.5), true);
  assert.equal(s.enregistrerMesureConso(5, 1), false, "trop court");
  assert.equal(s.enregistrerMesureConso(50, 40), false, "80 kWh/100 km : invraisemblable");
  assert.equal(s.consoMesuree(), null, "moins de 50 km au total");
  s.enregistrerMesureConso(45, 7.1);
  const m = s.consoMesuree();
  assert.equal(m.km, 75);
  assert.equal(m.kwh_100km, 15.5, "(4,5 + 7,1) kWh sur 75 km");
});

test("abonnements : le prix remplace le tarif public sur le bon réseau seulement", () => {
  s.sauverAbonnements([{ reseau: "Ionity", prix: 0.39 }]);
  const bornes = [
    { nom: "Aire A", operateur: "IONITY GmbH", prix_kwh_eur: 0.69, prix_est_estimation: false },
    { nom: "Aire B", operateur: "Electra", prix_kwh_eur: 0.49, prix_est_estimation: false },
  ];
  s.appliquerAbonnements(bornes);
  assert.equal(bornes[0].prix_kwh_eur, 0.39);
  assert.equal(bornes[0].prix_source, "abonnement");
  assert.equal(bornes[1].prix_kwh_eur, 0.49);
});

test("profil : la borne à domicile est enregistrée", () => {
  s.definirProfilVehicule({ puissance_domicile_kw: 7.4, puissance_dc_kw: 77 });
  const p = s.obtenirProfilVehicule();
  assert.equal(p.puissance_domicile_kw, 7.4);
  assert.equal(p.puissance_dc_kw, 77);
});

test("mise à jour des réglages enregistrés : marge 15 %, recharge 80 %, Kona 65 kWh", () => {
  localStorage.setItem("trajetve_prefs", JSON.stringify({ marge_pct: 12, cible_pct: 85, charge_pct: 60, mode: "confort" }));
  const p = s.lirePrefs();
  assert.equal(p.marge_pct, 15);
  assert.equal(p.cible_pct, 80);
  s.sauverPrefs({ ...p, marge_pct: 20 });
  assert.equal(s.lirePrefs().marge_pct, 20, "un choix fait ensuite est gardé");
  localStorage.setItem("trajetve_profil", JSON.stringify({ capacite_kwh: 64.8, puissance_dc_kw: 77 }));
  assert.equal(s.obtenirProfilVehicule().puissance_dc_kw, 89);
});

test("conso apprise par type de route (mesures surtout sur un type)", () => {
  localStorage.clear();
  s.enregistrerMesureConso(60, 12, { ville: 2, route: 3, autoroute: 55 }); // 20 kWh/100 sur autoroute
  s.enregistrerMesureConso(40, 5.6, { ville: 32, route: 8, autoroute: 0 }); // 14 en ville
  s.enregistrerMesureConso(30, 4.5, { ville: 10, route: 10, autoroute: 10 }); // mélangée : ignorée
  const c = s.consoParType();
  assert.equal(c.autoroute, 20);
  assert.equal(c.ville, 14);
  assert.equal(c.route, null);
});

test("trajet habituel : destination prise au moins 2 fois vers cette heure-ci", () => {
  localStorage.clear();
  const a8h = (j) => new Date(2026, 8, j, 8, 5).getTime();
  s.ajouterTrajetFait({ km: 20, destination: "Travail (Rennes)" });
  const liste = JSON.parse(localStorage.getItem("trajetve_trajets_faits"));
  liste[0].date = a8h(20);
  liste.push({ date: a8h(21), km: 20, destination: "Travail (Rennes)" }, { date: new Date(2026, 8, 21, 18).getTime(), km: 30, destination: "Chez moi" });
  localStorage.setItem("trajetve_trajets_faits", JSON.stringify(liste));
  assert.equal(s.destinationHabituelle(new Date(2026, 8, 26, 7, 40)), "Travail (Rennes)");
  assert.equal(s.destinationHabituelle(new Date(2026, 8, 26, 13, 0)), null);
});

test("temps de charge appris sur les recharges réelles (pauses trop longues écartées)", () => {
  localStorage.clear();
  assert.equal(s.facteurChargeAppris(), null);
  s.ajouterAuJournal({ lieu: "A", kwh: 30, duree_reelle_min: 33, duree_prevue_min: 30 });
  s.ajouterAuJournal({ lieu: "B", kwh: 30, duree_reelle_min: 90, duree_prevue_min: 30 }); // déjeuner : écartée
  s.ajouterAuJournal({ lieu: "C", kwh: 30, duree_reelle_min: 33, duree_prevue_min: 30 });
  assert.equal(s.facteurChargeAppris(), 1.1);
  assert.equal(s.obtenirProfilVehicule().facteur_charge_appris, 1.1);
});
