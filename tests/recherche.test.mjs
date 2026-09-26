import { test } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage, installerFetch } from "./aide.mjs";

installerLocalStorage();
const geo = await import("../js/geo.js");
const { rechercherLeLongDu } = await import("../js/recherche-route.js");
const s = await import("../js/storage.js");

test("suggestions d'adresses (Photon) puis position reprise sans nouvelle recherche", async () => {
  const appels = installerFetch(() => ({
    json: { features: [{ geometry: { coordinates: [-1.6778, 48.1113] }, properties: { name: "Gare de Rennes", street: "Place de la Gare", housenumber: "19", postcode: "35000", city: "Rennes", country: "France" } }] },
  }));
  const r = await geo.suggestionsLieux("gare renn", { lat: 48.1, lon: -1.68 });
  assert.ok(appels[0].url.includes("photon.komoot.io") && appels[0].url.includes("lat=48.100"));
  assert.equal(r[0].nom, "Gare de Rennes");
  assert.equal(r[0].libelle, "Gare de Rennes, 19 Place de la Gare, 35000, Rennes");
  geo.memoriserLieu(r[0].libelle, r[0].lat, r[0].lon);
  const lieu = await geo.resoudreLieu(r[0].libelle);
  assert.deepEqual([lieu.lat, lieu.lon], [48.1113, -1.6778]);
  assert.equal(appels.length, 1, "pas de géocodage : position déjà connue");
});

test("le long du trajet : détour en minutes, trié", async () => {
  const appels = installerFetch(() => ({
    json: { results: [{ poi: { name: "Café B" }, position: { lat: 48.2, lon: -1.6 }, detourTime: 420 }, { poi: { name: "Café A" }, position: { lat: 48.15, lon: -1.65 }, detourTime: 60 }] },
  }));
  const coords = Array.from({ length: 1000 }, (_, i) => [-1.68 + i * 0.001, 48.1]);
  const r = await rechercherLeLongDu("CLE", coords, "café");
  assert.equal(appels[0].options.method, "POST");
  assert.ok(JSON.parse(appels[0].options.body).route.points.length <= 401);
  assert.deepEqual(r.lieux.map((l) => [l.nom, l.detour_min]), [["Café A", 1], ["Café B", 7]]);
});

test("voiture garée : enregistrée, relue, oubliée", () => {
  s.garerVoiture(48.1, -1.68, "Rennes");
  assert.equal(s.voitureGaree().lieu, "Rennes");
  s.oublierVoitureGaree();
  assert.equal(s.voitureGaree(), null);
});
