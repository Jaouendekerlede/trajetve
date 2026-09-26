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

test("réponses à la voix : oui / non, et choix dans une liste", async () => {
  const { interpreterOuiNon: on, interpreterChoix: ch } = await import("../js/commandes-vocales.js");
  assert.equal(on("oui"), true);
  assert.equal(on("ouais vas-y"), true);
  assert.equal(on("non merci"), false);
  assert.equal(on("pas maintenant"), false);
  assert.equal(on("euh"), null);
  assert.equal(on(null), null);
  assert.equal(ch("la deuxième", 3), 1);
  assert.equal(ch("le premier", 3), 0);
  assert.equal(ch("3", 3), 2);
  assert.equal(ch("troisième", 2), null, "seulement deux choix");
  assert.equal(ch("aucun", 3), -1);
  assert.equal(c("autre borne s'il te plaît").action, "secours");
});

test("SOS : commande vocale et texte à envoyer aux secours", async () => {
  assert.equal(c("SOS").action, "sos");
  assert.equal(c("je suis en panne").action, "sos");
  assert.equal(c("la borne est en panne").action, "secours");
  const { texteSOS, phraseSOS } = await import("../js/sos.js");
  const info = { lat: 46.72891, lon: -0.61234, precision: 6, route: { numero: "A83", nom: "L'Océane", rapide: true }, pr: { km: "112,4", distanceM: 150 }, commune: "Faye-sur-Ardin, 79160", sens: "Niort" };
  const t = texteSOS(info);
  assert.ok(t.includes("A83 (L'Océane), sens Niort"));
  assert.ok(t.includes("PR) le plus proche : 112,4 (à 150 m)"));
  assert.ok(t.includes("46.72891, -0.61234 (précision 6 m)"));
  assert.ok(phraseSOS(info).startsWith("Vous êtes sur l'autoroute A 83"));
  assert.ok(phraseSOS({ ...info, route: { numero: "A 83", nom: "" } }).startsWith("Vous êtes sur l'autoroute A 83"), "« A 83 » écrit avec une espace (OpenStreetMap)");
  assert.ok(texteSOS({ ...info, reperes: "après la sortie 7, avant la sortie 8 (à 5 km)" }).includes("Repère : après la sortie 7"));
});
