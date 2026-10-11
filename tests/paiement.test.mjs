import { test } from "node:test";
import assert from "node:assert/strict";

const { facilitePaiement, lireMoyens, reseauDeLaBorne } = await import("../js/paiement.js");

const borne = (operateur, officiel) => ({ nom: "Borne", operateur, lat: 48, lon: -2, officiel });

test("moyens de paiement : carte bancaire seule par défaut", () => {
  assert.deepEqual(lireMoyens({}), { cb: true, badge: false, badgeId: "", badgeNom: "", reseaux: [] });
  assert.deepEqual(
    lireMoyens({ moyens_paiement: { cb: false, badge_id: "chargemap", reseaux: ["ionity"] } }),
    { cb: false, badge: true, badgeId: "chargemap", badgeNom: "Chargemap Pass", reseaux: ["ionity"] },
  );
  // Ancien réglage (avant l'ajout du choix précis) : gardé comme "autre badge".
  assert.deepEqual(
    lireMoyens({ moyens_paiement: { cb: true, badge: true, reseaux: [] } }),
    { cb: true, badge: true, badgeId: "autre", badgeNom: "ton badge multi-réseaux", reseaux: [] },
  );
});

test("moyens de paiement : ce qui est sûr, probable ou incertain sur une borne", () => {
  const cbSeule = lireMoyens({});
  assert.equal(facilitePaiement(borne("Ionity", { paiement_cb: "oui" }), cbSeule).niveau, "sur");
  assert.equal(facilitePaiement(borne("Ville de Vannes", { paiement_cb: "partiel" }), cbSeule).niveau, "probable");
  assert.equal(facilitePaiement(borne("Ville de Vannes", { paiement_cb: "non" }), cbSeule).niveau, "incertain");
  assert.equal(facilitePaiement(borne("Ville de Vannes", { paiement_cb: "non", gratuit: "oui" }), cbSeule).niveau, "sur", "gratuite");

  const avecBadge = { cb: true, badge: true, badgeId: "chargemap", badgeNom: "Chargemap Pass", reseaux: [] };
  const rBadge = facilitePaiement(borne("Ville de Vannes", { paiement_cb: "non" }), avecBadge);
  assert.equal(rBadge.niveau, "probable");
  assert.ok(rBadge.texte.includes("Chargemap Pass"), "nomme le badge choisi, pas un générique");
  assert.equal(facilitePaiement(borne("Tesla Supercharger", { paiement_cb: "non" }), avecBadge).niveau, "incertain", "pas de badge chez Tesla");

  const avecTesla = { cb: true, badge: false, reseaux: ["tesla"] };
  const r = facilitePaiement(borne("Tesla Supercharger", { paiement_cb: "non" }), avecTesla);
  assert.equal(r.niveau, "sur");
  assert.ok(r.texte.includes("Tesla"));
});

test("moyens de paiement : réseau reconnu d'après l'opérateur ou l'enseigne", () => {
  assert.equal(reseauDeLaBorne(borne("TotalEnergies Charging Services")).id, "totalenergies");
  assert.equal(reseauDeLaBorne(borne("Société X", { enseigne: "Power Dot France" })).id, "powerdot");
  assert.equal(reseauDeLaBorne(borne("Syndicat d'énergie du Morbihan")), null);
  assert.equal(reseauDeLaBorne(borne("Ionity", { indisponible: true })).id, "ionity");
});
