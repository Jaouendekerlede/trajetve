import { test } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const { bilanPreparation } = await import("../js/hors-ligne.js");

test("hors ligne : « prêt » seulement si la carte et le guidage ont vraiment été téléchargés", () => {
  const complet = bilanPreparation({ tuiles: 500, tuilesTotal: 500, annexes: 20, annexesTotal: 20, guidage: true });
  assert.equal(complet.complet, true);
  assert.match(complet.titre, /prêt/);
  // Quelques tuiles manquées sur des centaines : toléré.
  assert.equal(bilanPreparation({ tuiles: 490, tuilesTotal: 500, annexes: 20, annexesTotal: 20, guidage: true }).complet, true);
});

test("hors ligne : carte partielle, moteur incomplet ou guidage absent sont dits clairement", () => {
  const carte = bilanPreparation({ tuiles: 120, tuilesTotal: 500, annexes: 20, annexesTotal: 20, guidage: true });
  assert.equal(carte.complet, false);
  assert.ok(carte.lignes[0].includes("120 morceaux sur 500"));
  const moteur = bilanPreparation({ tuiles: 500, tuilesTotal: 500, annexes: 17, annexesTotal: 20, guidage: true });
  assert.equal(moteur.complet, false);
  assert.ok(moteur.lignes[0].includes("icônes, polices"));
  const guidage = bilanPreparation({ tuiles: 500, tuilesTotal: 500, annexes: 20, annexesTotal: 20, guidage: false });
  assert.equal(guidage.complet, false);
  assert.ok(guidage.lignes[1].includes("ne pourra pas démarrer"));
  assert.equal(bilanPreparation({ tuiles: 0, tuilesTotal: 0, annexes: 0, annexesTotal: 20, guidage: false }).complet, false);
});

test("hors ligne : les limites sont toujours rappelées, même quand tout est prêt", () => {
  const texte = bilanPreparation({ tuiles: 500, tuilesTotal: 500, annexes: 20, annexesTotal: 20, guidage: true }).lignes.join("\n");
  for (const limite of ["nouvel itinéraire", "trafic", "état des bornes", "2D"]) assert.ok(texte.includes(limite), limite);
});
