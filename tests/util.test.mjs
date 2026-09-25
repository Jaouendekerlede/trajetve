import { test } from "node:test";
import assert from "node:assert/strict";
import { hauteurSoleil, estNuit, avecMemoire, escapeHtml } from "../js/util.js";
import { haversineKm, pointADistanceSurTrace } from "../js/geo.js";

test("soleil : lever et coucher à Rennes le 25 septembre, à quelques minutes près", () => {
  const minute = (h, m) => new Date(Date.UTC(2026, 8, 25, h - 2, m)); // heure de Paris (UTC+2)
  assert.ok(hauteurSoleil(minute(7, 45), 48.11, -1.68) < -0.833, "avant 7 h 45 : pas encore levé");
  assert.ok(hauteurSoleil(minute(8, 10), 48.11, -1.68) > -0.833, "à 8 h 10 : levé");
  assert.ok(hauteurSoleil(minute(19, 45), 48.11, -1.68) > -0.833, "à 19 h 45 : pas encore couché");
  assert.ok(hauteurSoleil(minute(20, 10), 48.11, -1.68) < -0.833, "à 20 h 10 : couché");
});

test("nuit / jour", () => {
  assert.equal(estNuit(48.11, -1.68, new Date(Date.UTC(2026, 8, 25, 10))), false);
  assert.equal(estNuit(48.11, -1.68, new Date(Date.UTC(2026, 8, 25, 22))), true);
});

test("mémoire : garde seulement les succès et donne des copies indépendantes", async () => {
  let appels = 0;
  const calcul = async () => {
    appels++;
    return { ok: true, liste: [{ a: 1 }] };
  };
  const r1 = await avecMemoire("test-a", 60000, calcul);
  r1.liste[0].a = 99;
  const r2 = await avecMemoire("test-a", 60000, calcul);
  assert.equal(appels, 1, "second appel servi par la mémoire");
  assert.equal(r2.liste[0].a, 1, "la copie modifiée n'altère pas la mémoire");
  let echecs = 0;
  const echec = async () => {
    echecs++;
    return { ok: false };
  };
  await avecMemoire("test-b", 60000, echec);
  await avecMemoire("test-b", 60000, echec);
  assert.equal(echecs, 2, "un échec n'est jamais gardé");
});

test("échappement HTML", () => {
  assert.equal(escapeHtml(`<b>"L'été" & co</b>`), "&lt;b&gt;&quot;L&#39;été&quot; &amp; co&lt;/b&gt;");
  assert.equal(escapeHtml(null), "");
});

test("distances : Paris - Lyon à vol d'oiseau ≈ 392 km", () => {
  const d = haversineKm(48.8566, 2.3522, 45.764, 4.8357);
  assert.ok(Math.abs(d - 392) < 3, `obtenu ${d.toFixed(1)} km`);
});

test("point à une distance donnée sur un tracé", () => {
  const trace = [
    [0, 0],
    [0, 1],
  ]; // [lon, lat] : 1° de latitude ≈ 111 km
  const p = pointADistanceSurTrace(trace, 55.6);
  assert.ok(Math.abs(p.lat - 0.5) < 0.01 && Math.abs(p.lon) < 1e-9, JSON.stringify(p));
});
