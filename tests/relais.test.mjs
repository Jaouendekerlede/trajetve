import { test } from "node:test";
import assert from "node:assert/strict";
import { installerFetch, installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const { sauverReglages } = await import("../js/storage.js");
const { trajetSuggereParJarvis, publierFiabiliteOperateurs, publierCommandeVehicule } = await import("../js/relais.js");

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

test("fiabilité des opérateurs : publiée sur le relais, puis bridée (5 min) pour ne pas le spammer", async () => {
  const appels = installerFetch(() => ({ json: { ok: true } }));
  await publierFiabiliteOperateurs({ "power dot": { frais: 3, ancien: 0, aucune: 0 } });
  await publierFiabiliteOperateurs({ "power dot": { frais: 4, ancien: 0, aucune: 0 } }); // juste après : ignoré
  const appelsFiabilite = appels.filter((a) => a.url.includes("/fiabilite-operateurs"));
  assert.equal(appelsFiabilite.length, 1, "le deuxième appel immédiat est filtré");
  assert.equal(JSON.parse(appelsFiabilite[0].options.body)["power dot"].frais, 3);
});

test("commande véhicule : préchauffage publié sur le relais avec les bonnes infos", async () => {
  const appels = installerFetch(() => ({ json: { ok: true } }));
  await publierCommandeVehicule("prechauffage", { lat: 47.2, lon: -1.5, nom_borne: "Aire du Test" });
  const appelsCommande = appels.filter((a) => a.url.includes("/commande-vehicule"));
  assert.equal(appelsCommande.length, 1);
  const corps = JSON.parse(appelsCommande[0].options.body);
  assert.equal(corps.action, "prechauffage");
  assert.equal(corps.lat, 47.2);
  assert.equal(corps.nom_borne, "Aire du Test");
  assert.ok(corps.ts > 0);
});

test("commande véhicule : silencieux si le relais échoue (ne doit jamais planter la navigation)", async () => {
  installerFetch(() => ({ statut: 500, json: {} }));
  await assert.doesNotReject(() => publierCommandeVehicule("prechauffage", { lat: 1, lon: 1 }));
});
