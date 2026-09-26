import { test } from "node:test";
import assert from "node:assert/strict";
import { alerteMeteo, mesuresA } from "../js/meteo-route.js";
import { statistiques } from "../js/statistiques.js";

test("météo : alerte la plus grave, rien par beau temps", () => {
  assert.equal(alerteMeteo({ code: 95, precip: 10 }).type, "orage");
  assert.equal(alerteMeteo({ code: 73 }).type, "neige");
  assert.equal(alerteMeteo({ temp: 0, precip: 0.3, code: 61 }).type, "verglas");
  assert.equal(alerteMeteo({ precip: 6, code: 63 }).type, "pluie");
  assert.equal(alerteMeteo({ rafales: 85 }).type, "vent");
  assert.equal(alerteMeteo({ code: 45 }).type, "brouillard");
  assert.equal(alerteMeteo({ code: 1, precip: 0.2, rafales: 30, temp: 15 }), null);
  const m = mesuresA({ time: [0, 3600, 7200], precipitation: [0, 5, 0], weather_code: [0, 63, 0], wind_gusts_10m: [0, 0, 0], temperature_2m: [9, 9, 9] }, 3500);
  assert.equal(m.precip, 5);
});

test("statistiques : période, économie vs essence, prix réel du journal", () => {
  const maintenant = Date.UTC(2026, 8, 26, 12);
  const trajets = [{ date: Date.UTC(2026, 8, 10), km: 100, kwh: 15 }, { date: Date.UTC(2026, 2, 1), km: 200, kwh: 30 }];
  const journal = [{ ts: Date.UTC(2026, 8, 11), kwh: 20, cout_eur: 5 }];
  const essence = { prix_l: 2, conso_l_100: 6 };
  const mois = statistiques(trajets, journal, "mois", maintenant, essence);
  assert.equal(mois.km, 100);
  assert.equal(mois.recharges, 1);
  // 15 kWh à 0,25 €/kWh (prix réel du journal) = 3,75 € ; essence 100 km = 12 €.
  assert.ok(Math.abs(mois.economie - 8.25) < 0.01);
  assert.equal(statistiques(trajets, journal, "annee", maintenant, essence).km, 300);
  assert.ok(Math.abs(statistiques(trajets, journal, "tout", maintenant, essence).co2_evite_kg - 31.5) < 0.01);
});
