import { test } from "node:test";
import assert from "node:assert/strict";
import { interpreterCommande as c } from "../js/commandes-vocales.js";

test("commandes vocales comprises", () => {
  assert.deepEqual(c("Coupe le son"), { action: "voix", valeur: false });
  assert.deepEqual(c("remets la voix"), { action: "voix", valeur: true });
  assert.equal(c("la route est barrée").action, "barree");
  assert.equal(c("prochaine borne ?").action, "borne");
  assert.equal(c("combien de temps il reste").action, "arrivee");
  assert.equal(c("il me reste combien de batterie").action, "batterie");
  assert.deepEqual(c("trouve une boulangerie"), { action: "recherche", requete: "boulangerie" });
  assert.deepEqual(c("j'ai envie d'un café"), { action: "recherche", requete: "café" });
  assert.equal(c("où me garer").action, "parkings");
  assert.equal(c("préviens que j'arrive").action, "partage");
  assert.deepEqual(c("aller à Nantes"), { action: "aller", lieu: "Nantes" });
  assert.deepEqual(c("emmène-moi à la maison"), { action: "aller", lieu: "Chez moi" });
  assert.equal(c("bla bla").action, "inconnu");
});
