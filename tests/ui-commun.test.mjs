import { test } from "node:test";
import assert from "node:assert/strict";

const { euros, nombreAffiche } = await import("../js/ui-commun.js");

test("nombreAffiche : groupe les milliers (espace fine insécable), virgule décimale, inchangé sous 1000", () => {
  assert.equal(nombreAffiche(48000), "48 000");
  assert.equal(nombreAffiche(88000), "88 000");
  assert.equal(nombreAffiche(1278), "1 278");
  assert.equal(nombreAffiche(762), "762");
  assert.equal(nombreAffiche(0.501, 3), "0,501");
  assert.equal(nombreAffiche(1234567), "1 234 567");
  assert.equal(nombreAffiche(-1500), "-1 500");
});

test("euros : même groupement par milliers, toujours 2 décimales", () => {
  assert.equal(euros(48000), "48 000,00 €");
  assert.equal(euros(52.36), "52,36 €");
  assert.equal(euros(1234.5), "1 234,50 €");
  assert.equal(euros(-1500), "-1 500,00 €");
});
