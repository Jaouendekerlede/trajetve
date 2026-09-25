import { test } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage, installerFetch } from "./aide.mjs";

installerLocalStorage();
const { calculerItineraireTomTom } = await import("../js/tomtom.js");
const { chargerEtatsDynamiques, etatStation } = await import("../js/irve.js");
const { rechercherParkings } = await import("../js/parkings.js");

function routeTomTom(km) {
  return {
    summary: { lengthInMeters: km * 1000, travelTimeInSeconds: km * 40 },
    legs: [{ summary: {}, points: [{ latitude: 48, longitude: -1 }, { latitude: 48.5, longitude: -1 }] }],
    sections: [],
  };
}

test("TomTom : refus des sections de vitesse (400) → nouvel essai sans elles", async () => {
  let n = 0;
  const appels = installerFetch(() => (++n === 1 ? { statut: 400, json: {} } : { json: { routes: [routeTomTom(50), routeTomTom(60)] } }));
  const r = await calculerItineraireTomTom("cle", 48, -1, 48.5, -1, { maxAlternatives: 1 });
  assert.equal(r.erreur, null);
  assert.equal(appels.length, 2);
  assert.ok(appels[0].url.includes("sectionType=speedLimit") && !appels[1].url.includes("speedLimit"));
  assert.equal(r.alternatives.length, 1, "la 2e route est une alternative");
});

test("TomTom : les voies ne sont demandées qu'en navigation", async () => {
  const appels = installerFetch(() => ({ json: { routes: [routeTomTom(50)] } }));
  await calculerItineraireTomTom("cle", 48, -1, 48.5, -1, {});
  await calculerItineraireTomTom("cle", 48, -1, 48.5, -1, { instructions: true });
  assert.ok(!appels[0].url.includes("sectionType=lanes"));
  assert.ok(appels[1].url.includes("sectionType=lanes") && appels[1].url.includes("language=fr-FR"));
});

test("TomTom : clé absente et clé refusée", async () => {
  assert.equal((await calculerItineraireTomTom("", 48, -1, 48.5, -1)).erreur, "cle_manquante");
  installerFetch(() => ({ statut: 403, json: {} }));
  assert.equal((await calculerItineraireTomTom("cle", 48, -1, 48.5, -1)).erreur, "http_403");
});

test("état des bornes : points hors service et occupation récente", async () => {
  const maintenant = new Date().toISOString().replace("T", " ");
  const csv = [
    "id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage,etat_prise_type_2",
    "FR1,hors_service,inconnu,2026-09-22 10:00:00+00:00,",
    "FR2,hors_service,inconnu,2026-09-23 10:00:00+00:00,",
    `FR3,en_service,libre,${maintenant},`,
    "FR4,en_service,libre,2020-01-01 00:00:00+00:00,",
  ].join("\n");
  installerFetch(() => ({ texte: csv }));
  await chargerEtatsDynamiques();
  const panne = etatStation({ ids_pdc: ["FR1", "FR2"] });
  assert.equal(panne.tous_hors_service, true);
  assert.equal(panne.hors_service, 2);
  const mixte = etatStation({ ids_pdc: ["FR1", "FR3", "FR4"] });
  assert.equal(mixte.tous_hors_service, false);
  assert.equal(mixte.libres, 1, "FR4 : occupation trop ancienne, ignorée");
  assert.equal(etatStation({ ids_pdc: ["FR4"] }), null, "rien de récent ni de hors service");
});

test("parkings : seuls les parkings utiles au public sont gardés", async () => {
  installerFetch(() => ({
    json: {
      elements: [
        { type: "way", id: 1, center: { lat: 48.1, lon: -1.6 }, tags: { amenity: "parking", name: "Parking Gare", capacity: "400", fee: "yes", "capacity:charging": "12" } },
        { type: "way", id: 2, center: { lat: 48.1, lon: -1.6 }, tags: { amenity: "parking", access: "private", name: "Résidence" } },
        { type: "node", id: 3, lat: 48.1, lon: -1.6, tags: { amenity: "parking", capacity: "8" } },
        { type: "way", id: 4, center: { lat: 48.1, lon: -1.6 }, tags: { amenity: "parking", parking: "underground" } },
      ],
    },
  }));
  const r = await rechercherParkings({ sud: 48.09, ouest: -1.61, nord: 48.11, est: -1.59 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.parkings.map((p) => p.nom), ["Parking Gare", "Parking souterrain"]);
  assert.equal(r.parkings[0].places_recharge, 12);
  assert.equal(r.parkings[0].payant, "oui");
});

test("parkings : serveur principal muet → serveur de secours", async () => {
  const appels = installerFetch((url) => (url.includes("overpass-api.de") ? { statut: 504, json: {} } : { json: { elements: [{ type: "node", id: 9, lat: 1, lon: 1, tags: { name: "P secours" } }] } }));
  const r = await rechercherParkings({ sud: 1.001, ouest: 1.001, nord: 1.002, est: 1.002 });
  assert.equal(r.ok, true);
  assert.equal(appels.length, 2);
  assert.equal(r.parkings[0].nom, "P secours");
});
