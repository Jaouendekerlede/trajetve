import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage, installerFetch } from "./aide.mjs";

installerLocalStorage();
const { construireCsvJournal, synchroniserRechargesDetectees } = await import("../js/ui-journal.js");
const { sauverReglages, definirProfilVehicule, listerJournal } = await import("../js/storage.js");

beforeEach(() => localStorage.clear());

test("export CSV du journal : point-virgule, virgule décimale, total, accents protégés", () => {
  const journal = [
    { ts: new Date("2026-09-15T10:00:00").getTime(), lieu: "Ionity Rennes", kwh: 32.456, cout_eur: 18.5, source: "navigation" },
    { ts: new Date("2026-09-01T08:00:00").getTime(), lieu: "Domicile; soir", kwh: 10, cout_eur: 2.5, source: "manuel" },
  ];
  const csv = construireCsvJournal(journal);
  const lignes = csv.replace(/^﻿/, "").split("\r\n");
  assert.equal(lignes[0], "Date;Lieu;Énergie (kWh);Coût (€);Source");
  // Trié chronologiquement (le plus ancien d'abord), pas l'ordre d'entrée.
  assert.ok(lignes[1].startsWith("01/09/2026;"), `obtenu : ${lignes[1]}`);
  assert.ok(lignes[1].includes('"Domicile; soir"'), "le point-virgule dans un champ est protégé par des guillemets");
  assert.ok(lignes[2].startsWith("15/09/2026;Ionity Rennes;32,46;18,50;Navigation"), `obtenu : ${lignes[2]}`);
  const total = lignes[3];
  assert.ok(total.startsWith("Total;;42,46;21,00;2 recharges"), `obtenu : ${total}`);
  assert.equal(csv.charCodeAt(0), 0xfeff, "BOM UTF-8 pour Excel");
});

test("synchronisation Bluelink : importe une recharge détectée, estime le kWh depuis le profil", async () => {
  sauverReglages({ relais_url: "https://relais.test" });
  definirProfilVehicule({ capacite_kwh: 64 });
  installerFetch(() => ({ json: { ok: true, recharges: [{ ts_fin: 1000, batterie_pct_debut: 20, batterie_pct_fin: 84, odometre_km: 12345 }] } }));
  const importees = await synchroniserRechargesDetectees();
  assert.equal(importees, 1);
  const journal = listerJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].source, "bluelink");
  assert.equal(journal[0].kwh, 40.96, "(84-20)% de 64 kWh");
  assert.equal(journal[0].odometre_km, 12345);
  assert.equal(journal[0].id_bluelink, 1000);
});

test("synchronisation Bluelink : une recharge déjà importée n'est pas dupliquée", async () => {
  sauverReglages({ relais_url: "https://relais.test" });
  installerFetch(() => ({ json: { ok: true, recharges: [{ ts_fin: 1000, batterie_pct_debut: 20, batterie_pct_fin: 80, odometre_km: 100 }] } }));
  assert.equal(await synchroniserRechargesDetectees(), 1);
  assert.equal(await synchroniserRechargesDetectees(), 0, "déjà connue (même ts_fin) : pas réimportée");
  assert.equal(listerJournal().length, 1);
});

test("synchronisation Bluelink : sans relais configuré, ne fait rien", async () => {
  assert.equal(await synchroniserRechargesDetectees(), 0);
  assert.equal(listerJournal().length, 0);
});
