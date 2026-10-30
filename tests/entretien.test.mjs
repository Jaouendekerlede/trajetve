import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const { construireCsvEntretien } = await import("../js/ui-entretien.js");
const { listerEntretien, ajouterEntretien, modifierEntretien, retirerEntretien, coutParKm, definirProfilVehicule, ajouterAuJournal } = await import("../js/storage.js");

beforeEach(() => localStorage.clear());

test("carnet d'entretien : ajout, liste (plus récent en premier n'est pas garanti par date -- juste l'ordre d'ajout), modification, suppression", () => {
  ajouterEntretien({ type: "Vidange", date_ts: 1000, cout_eur: 80 });
  ajouterEntretien({ type: "Pneus", date_ts: 2000, cout_eur: 400 });
  let liste = listerEntretien();
  assert.equal(liste.length, 2);
  assert.equal(liste[0].type, "Pneus", "le dernier ajouté est en tête (comme le journal)");

  const id = liste[1].id;
  modifierEntretien(id, { cout_eur: 85 });
  liste = listerEntretien();
  assert.equal(liste.find((e) => e.id === id).cout_eur, 85);

  retirerEntretien(id);
  assert.equal(listerEntretien().length, 1);
});

test("coût au km : non calculable sans kilométrage renseigné", () => {
  ajouterEntretien({ type: "Vidange", date_ts: Date.now(), cout_eur: 100 });
  assert.equal(coutParKm(), null);
});

test("coût au km : non calculable si la distance n'est pas positive", () => {
  definirProfilVehicule({ kilometrage_initial_km: 10000, kilometrage_actuel_km: 10000 });
  assert.equal(coutParKm(), null, "distance nulle");
  definirProfilVehicule({ kilometrage_initial_km: 10000, kilometrage_actuel_km: 9000 });
  assert.equal(coutParKm(), null, "distance négative");
});

test("coût au km : additionne recharge + entretien, divise par la distance réelle", () => {
  definirProfilVehicule({ kilometrage_initial_km: 0, kilometrage_actuel_km: 1000 });
  ajouterAuJournal({ lieu: "Domicile", kwh: 50, cout_eur: 100, source: "manuel" });
  ajouterEntretien({ type: "Vidange", date_ts: Date.now(), cout_eur: 150 });
  const r = coutParKm();
  assert.ok(r);
  assert.equal(r.cout_recharge, 100);
  assert.equal(r.cout_entretien, 150);
  assert.equal(r.distance_km, 1000);
  assert.equal(r.eur_par_km, 0.25, "(100 + 150) / 1000");
});

test("export CSV de l'entretien : point-virgule, virgule décimale, total, accents protégés", () => {
  const entretien = [
    { date_ts: new Date("2026-09-15T10:00:00").getTime(), type: "Révision; complète", cout_eur: 180.5 },
    { date_ts: new Date("2026-09-01T08:00:00").getTime(), type: "Vidange", km: 45000, cout_eur: 80, prochaine_date_ts: new Date("2027-09-01").getTime(), prochain_km: 55000, notes: "Huile 5W30" },
  ];
  const csv = construireCsvEntretien(entretien);
  const lignes = csv.replace(/^﻿/, "").split("\r\n");
  assert.equal(lignes[0], "Date;Type;Km;Coût (€);Prochaine échéance (date);Prochaine échéance (km);Notes");
  assert.ok(lignes[1].startsWith("01/09/2026;Vidange;45000;80,00;01/09/2027;55000;Huile 5W30"), `obtenu : ${lignes[1]}`);
  assert.ok(lignes[2].includes('"Révision; complète"'), "le point-virgule dans un champ est protégé par des guillemets");
  assert.ok(lignes[3].startsWith("Total;;;260,50;;;2 entretiens"), `obtenu : ${lignes[3]}`);
  assert.equal(csv.charCodeAt(0), 0xfeff, "BOM UTF-8 pour Excel");
});
