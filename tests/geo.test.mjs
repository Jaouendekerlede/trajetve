import { test } from "node:test";
import assert from "node:assert/strict";
import { recalerSurRoutes } from "../js/geo.js";

// Reproduit un rond-point/virage serré : deux routes proches l'une de
// l'autre, une qui prolonge logiquement le tracé (« correct ») et une qui
// n'est proche que du point du milieu, de l'autre côté (« leurre »). Sans
// continuité avec le point déjà recalé, le point du milieu saute sur le
// leurre, coupant la courbe (vu en vrai en navigation 3D, corrigé le
// 2026-10-30).
const LAT0 = 47.0, LON0 = -2.0;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const versCoord = (xm, ym) => [LON0 + xm / KX, LAT0 + ym / KY];
const yEnMetres = (point) => (point[1] - LAT0) * KY;

test("recalerSurRoutes : garde la continuité au lieu de sauter sur une route proche mais isolée", () => {
  const points = [versCoord(0, 0), versCoord(10, 0), versCoord(20, 0)];
  const correct = [versCoord(3, 1.5), versCoord(17, 1.5)];
  const leurre = [versCoord(8, -1.4), versCoord(12, -1.4)];

  const resultat = recalerSurRoutes(points, [correct, leurre], 14);

  for (const p of resultat) assert.ok(Math.abs(yEnMetres(p) - 1.5) < 0.01, "chaque point doit rester sur la route qui prolonge le tracé");
});
