import { test } from "node:test";
import assert from "node:assert/strict";
import { construireRoute, distanceAffichee, messageCourt, svgFleche } from "../js/nav-outils.js";

// Réponse TomTom minimale : 11 points vers l'est (~100 m chacun), 2 tronçons.
const points = Array.from({ length: 11 }, (_, i) => [-1.68 + i * 0.001345, 48.1]);
const reponse = {
  coords: points,
  summary: { travelTimeInSeconds: 120 },
  legs: [{ nbPoints: 6, summary: { travelTimeInSeconds: 60 } }, { nbPoints: 5, summary: { travelTimeInSeconds: 60 } }],
  guidance: {
    instructions: [
      { pointIndex: 0, instructionType: "LOCATION_DEPARTURE", maneuver: "DEPART", message: "Partir" },
      { pointIndex: 4, instructionType: "TURN", maneuver: "TURN_RIGHT", message: "Tournez à droite sur Rue X", street: "Rue X", signpostText: "Nantes", junctionType: "REGULAR" },
      { pointIndex: 8, instructionType: "TURN", maneuver: "ROUNDABOUT_CROSS", message: "Au rond-point, prenez la premier sortie", junctionType: "ROUNDABOUT", roundaboutExitNumber: 1 },
    ],
  },
  sections: [
    { sectionType: "SPEED_LIMIT", startPointIndex: 0, endPointIndex: 10, maxSpeedLimitInKmh: 50 },
    { sectionType: "MOTORWAY", startPointIndex: 2, endPointIndex: 5 },
    { sectionType: "TRAFFIC", simpleCategory: "ROAD_WORK", startPointIndex: 6, endPointIndex: 7, delayInSeconds: 180 },
    { sectionType: "LANES", startPointIndex: 3, endPointIndex: 4, lanes: [{ directions: ["STRAIGHT"] }, { directions: ["RIGHT"], follow: "RIGHT" }] },
  ],
};

test("itinéraire de guidage construit depuis la réponse TomTom", () => {
  const r = construireRoute(reponse);
  assert.ok(Math.abs(r.total - 1000) < 5, `${r.total} m`);
  assert.equal(r.troncons.length, 2);
  assert.ok(r.limites.every((l) => l === 50));
  const virage = r.instructions.find((i) => i.manoeuvre === "TURN_RIGHT");
  assert.ok(Math.abs(virage.offset - 400) < 5);
  assert.equal(virage.rue, "Rue X");
  assert.equal(virage.message, "Tournez à droite sur Rue X, direction Nantes", "direction ajoutée");
  const rp = r.instructions.find((i) => i.manoeuvre === "ROUNDABOUT_CROSS");
  assert.equal(rp.message, "Au rond-point, prenez la première sortie", "faute TomTom corrigée");
  assert.equal(r.voies.length, 1);
  assert.equal(r.travaux.length, 1);
  assert.equal(r.travaux[0].retard_min, 3);
  assert.equal(r.autoroutes.length, 1);
});

test("textes courts et flèches du bandeau", () => {
  assert.equal(distanceAffichee(1234), "1,2 km");
  assert.equal(distanceAffichee(12400), "12 km");
  assert.equal(distanceAffichee(230), "250 m");
  assert.equal(messageCourt("Au rond-point, prenez la deuxième sortie, direction Niort"), "rond-point, deuxième sortie");
  assert.equal(messageCourt("Vous êtes arrivé à Rue X"), "arrivée");
  assert.ok(svgFleche({ manoeuvre: "TURN_LEFT" }).startsWith("<svg"));
  assert.ok(svgFleche({ manoeuvre: "ARRIVE" }).includes("🏁"));
});

test("présentation : pas devant une navigation, un raccourci ou un lien de restauration", async () => {
  const { presentationAutorisee, MENTION_COURTE, MENTION_LEGALE } = await import("../js/presentation.js");
  assert.equal(presentationAutorisee({ search: "", hash: "" }, false), true);
  assert.equal(presentationAutorisee({ search: "", hash: "" }, true), false, "navigation à reprendre");
  assert.equal(presentationAutorisee({ search: "?action=maison", hash: "" }, false), false, "raccourci de l'icône");
  assert.equal(presentationAutorisee({ search: "", hash: "#restaurer=abc" }, false), false);
  assert.ok(MENTION_COURTE.includes("Jean-Luc RIO") && MENTION_COURTE.includes("Tous droits réservés"));
  assert.ok(MENTION_LEGALE.includes("L.122-4"));
});
