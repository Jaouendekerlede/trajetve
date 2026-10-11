import { test } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const { construireCsvJournal } = await import("../js/ui-journal.js");

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
