import { test } from "node:test";
import assert from "node:assert/strict";
import { installerFetch, installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const { sauverReglages } = await import("../js/storage.js");
const { trajetSuggereParJarvis } = await import("../js/relais.js");

sauverReglages({ relais_url: "https://relais.test" });

test("trajet suggéré par JARVIS : repris si récent et avec destination", async () => {
  installerFetch(() => ({ json: { ok: true, destination: "12 rue de la Santé, Nantes", titre: "RDV médecin", heure: "2026-10-11T14:00:00", maj_ts: Date.now() } }));
  const s = await trajetSuggereParJarvis();
  assert.equal(s.destination, "12 rue de la Santé, Nantes");
  assert.equal(s.titre, "RDV médecin");
});

test("trajet suggéré par JARVIS : ignoré si trop ancien (opérateur silencieux depuis des heures)", async () => {
  installerFetch(() => ({ json: { ok: true, destination: "Quelque part", maj_ts: Date.now() - 5 * 3600 * 1000 } }));
  assert.equal(await trajetSuggereParJarvis(), null);
});

test("trajet suggéré par JARVIS : rien si le relais ne répond pas (sans planter)", async () => {
  installerFetch(() => ({ statut: 500, json: {} }));
  assert.equal(await trajetSuggereParJarvis(), null);
});

test("trajet suggéré par JARVIS : rien sans destination publiée", async () => {
  installerFetch(() => ({ statut: 404, json: { ok: false, erreur: "aucun trajet suggéré" } }));
  assert.equal(await trajetSuggereParJarvis(), null);
});
