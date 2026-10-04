import { test } from "node:test";
import assert from "node:assert/strict";

const { lignesEtat } = await import("../js/etat-appli.js");

const base = { enLigne: true, gpsPermission: "granted", gpsTest: null, cles: { tomtom: true, openChargeMap: true }, quota: { utilise: 12, max: 2500 }, etatsBornesAgeMin: 20, guidagePrepare: null, regionPreparee: false, guidage: null };
const ligne = (info, titre) => lignesEtat(info).find((l) => l.titre.startsWith(titre));

test("état de l'appli : tout va bien", () => {
  const l = lignesEtat({ ...base, gpsTest: { precision: 8, niveau: "bon" } });
  assert.equal(l.filter((x) => x.niveau === "attention").length, 0);
  assert.match(ligne({ ...base, gpsTest: { precision: 8, niveau: "bon" } }, "GPS").texte, /précision bonne \(±8 m\)/);
});

test("état de l'appli : chaque manque est dit en clair", () => {
  assert.equal(ligne({ ...base, enLigne: false }, "Réseau").niveau, "attention");
  assert.match(ligne({ ...base, gpsPermission: "denied" }, "GPS").texte, /refusée/);
  assert.equal(ligne({ ...base, gpsTest: { precision: 85, niveau: "mauvais" } }, "GPS").niveau, "attention");
  assert.match(ligne({ ...base, gpsTest: { erreur: "Aucune position reçue." } }, "GPS").texte, /Aucune position/);
  assert.match(ligne({ ...base, cles: { tomtom: false, openChargeMap: true } }, "Clé TomTom").texte, /aucun itinéraire/);
  assert.ok(ligne({ ...base, quota: { utilise: 2400, max: 2500 } }, "Quota TomTom"));
  assert.equal(ligne(base, "Quota TomTom"), undefined);
});

test("état de l'appli : une donnée jamais chargée ou ancienne n'est pas présentée comme fraîche", () => {
  assert.match(ligne({ ...base, etatsBornesAgeMin: null }, "État des bornes").texte, /Pas encore téléchargé/);
  const ancien = ligne({ ...base, etatsBornesAgeMin: 300 }, "État des bornes");
  assert.equal(ancien.niveau, "attention");
  assert.match(ancien.texte, /il y a 5 h/);
  assert.match(ligne(base, "Trajet préparé").texte, /ne pourra pas démarrer/);
  const vieux = ligne({ ...base, guidagePrepare: { ageMin: 10 * 1440, nbArrets: 2 } }, "Trajet préparé");
  assert.equal(vieux.niveau, "attention");
  assert.match(vieux.texte, /il y a 10 jours \(2 borne/);
});

test("état de l'appli : pendant un guidage, l'état du signal sans aucune coordonnée", () => {
  const g = ligne({ ...base, guidage: { signal: "estime", niveau: "bon", age_s: 12, ecartees: 3, estimations: 1 } }, "Guidage en cours");
  assert.equal(g.niveau, "attention");
  assert.match(g.texte, /position estimée/);
  assert.match(g.texte, /3 mesure\(s\) écartée\(s\)/);
  const texte = JSON.stringify(lignesEtat({ ...base, guidage: { signal: "suivi", niveau: "bon", age_s: 0.4, ecartees: 0, estimations: 0 } }));
  assert.ok(!/\d{1,2}\.\d{4,}/.test(texte), "aucune coordonnée dans le texte");
});
