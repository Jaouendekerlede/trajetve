import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const j = await import("../js/journal-erreurs.js");
const { interpreterCommande: c } = await import("../js/commandes-vocales.js");

beforeEach(() => j.effacer());

test("journal : noté, sans doublon rapproché, limité en taille", () => {
  const t0 = 1_000_000;
  j.noter("reseau", "réseau perdu", t0);
  j.noter("reseau", "réseau perdu", t0 + 5000); // doublon : ignoré
  j.noter("reseau", "réseau perdu", t0 + 60000); // plus tard : gardé
  assert.equal(j.lister().length, 2);
  for (let i = 0; i < 400; i++) j.noter("nav", `événement ${i}`, t0 + 100000 + i * 40000);
  assert.equal(j.lister().length, j.MAX_ENTREES);
  assert.equal(j.lister().at(-1).msg, "événement 399");
  j.noter("nav", "x".repeat(1000), t0 + 999_999_999);
  assert.ok(j.lister().at(-1).msg.length <= 240);
});

test("aucune clé ni jeton dans le journal ni dans le rapport", () => {
  j.noter("avert", "GET https://api.tomtom.com/routing/1/calculateRoute/a:b/json?key=SECRETTOMTOM123&traffic=true 403");
  j.noter("erreur", "Authorization: Bearer ya29.TOKENTRESLONG et la clé MASUPERCLEOCM99 a échoué");
  const rapport = j.construireRapport({ version: "50", date: "27/09/2026", appareil: "Test", reseau: true, cles: { tomtom: true }, reglages: { taille_texte_nav: 110 }, navigation: { km_faits: 12 } }, j.lister(), ["SECRETTOMTOM123", "MASUPERCLEOCM99"]);
  for (const secret of ["SECRETTOMTOM123", "ya29.TOKENTRESLONG", "MASUPERCLEOCM99"]) assert.ok(!rapport.includes(secret), `${secret} présent`);
  assert.ok(rapport.includes("key=***"));
  assert.ok(rapport.includes("Version : 50") && rapport.includes("km_faits=12") && rapport.includes("taille_texte_nav=110"));
});

test("signalement : repérable dans le rapport, et commande vocale reconnue", () => {
  j.noter("signalement", "à la voix, km 42, vitesse 90 km/h", Date.UTC(2026, 8, 27, 10, 30));
  const rapport = j.construireRapport({ date: "x", reseau: false }, j.lister());
  assert.ok(rapport.includes("SIGNALEMENTS") && rapport.includes("km 42"));
  assert.ok(rapport.includes("réseau : NON"));
  assert.equal(c("signale un problème").action, "signaler");
  assert.equal(c("il y a un bug").action, "signaler");
  assert.equal(c("note ça").action, "signaler");
  assert.equal(c("je suis en panne").action, "sos", "une vraie panne reste un SOS");
});
