import { test } from "node:test";
import assert from "node:assert/strict";
import { elementsEntretienDus } from "../js/alerte-entretien.js";

const AUJOURDHUI = new Date("2026-10-30T10:00:00");
const JOUR_MS = 86400000;

test("rien dû : échéances lointaines (date et km)", () => {
  const entretien = [{ id: "a", type: "Vidange", prochaine_date_ts: AUJOURDHUI.getTime() + 60 * JOUR_MS, prochain_km: 60000 }];
  assert.deepEqual(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI, kmActuel: 50000 }), []);
});

test("dû par date : échéance dans moins de 14 jours (réglage par défaut)", () => {
  const entretien = [{ id: "a", type: "Contrôle technique", prochaine_date_ts: AUJOURDHUI.getTime() + 5 * JOUR_MS }];
  const dus = elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI });
  assert.equal(dus.length, 1);
  assert.equal(dus[0].id, "a");
});

test("dû par date : échéance déjà dépassée", () => {
  const entretien = [{ id: "a", type: "Assurance", prochaine_date_ts: AUJOURDHUI.getTime() - 10 * JOUR_MS }];
  assert.equal(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI }).length, 1);
});

test("dû par km : à moins de 500 km (réglage par défaut), pas kmActuel fourni -> jamais dû par km", () => {
  const entretien = [{ id: "a", type: "Vidange", prochain_km: 50200 }];
  assert.equal(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI, kmActuel: 50000 }).length, 1);
  assert.equal(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI }).length, 0, "kmActuel inconnu : pas de comparaison possible");
});

test("dû par km : hors marge, pas encore dû", () => {
  const entretien = [{ id: "a", type: "Vidange", prochain_km: 51000 }];
  assert.equal(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI, kmActuel: 50000 }).length, 0);
});

test("dû par date OU par km, ne compte qu'une fois ; plusieurs entrées mélangées", () => {
  const entretien = [
    { id: "proche-date", prochaine_date_ts: AUJOURDHUI.getTime() + 1 * JOUR_MS },
    { id: "proche-km", prochain_km: 50100 },
    { id: "loin", prochaine_date_ts: AUJOURDHUI.getTime() + 365 * JOUR_MS, prochain_km: 90000 },
    { id: "sans-echeance" },
  ];
  const dus = elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI, kmActuel: 50000 });
  assert.deepEqual(dus.map((e) => e.id).sort(), ["proche-date", "proche-km"]);
});

test("réglages personnalisés : delaiJours et margeKm", () => {
  const entretien = [{ id: "a", prochaine_date_ts: AUJOURDHUI.getTime() + 20 * JOUR_MS }];
  assert.equal(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI, delaiJours: 14 }).length, 0);
  assert.equal(elementsEntretienDus(entretien, { aujourdhui: AUJOURDHUI, delaiJours: 30 }).length, 1);
});
