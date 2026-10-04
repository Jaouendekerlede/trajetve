import { test } from "node:test";
import assert from "node:assert/strict";
import { installerFetch } from "./aide.mjs";

const p = await import("../js/partage-position.js");

test("position en direct : adresse de partage au hasard, reconnue par la page de suivi", () => {
  const a = p.creerSujet();
  const b = p.creerSujet();
  assert.notEqual(a, b);
  assert.ok(p.estSujet(a) && a.length === 36, a);
  assert.equal(p.estSujet("tve-123"), false);
  assert.equal(p.estSujet(""), false);
  assert.equal(p.lienSuivi(a, "https://exemple.fr/trajetve/index.html?action=bornes"), `https://exemple.fr/trajetve/suivi.html#${a}`);
});

test("position en direct : message réduit au nécessaire, valeurs arrondies", () => {
  const m = p.messagePosition({ lat: 48.123456789, lon: -2.987654321, cap: 91.7, kmh: 87.4, arrivee_ms: 1_760_000_123_456.7, restant_km: 41.6, batterie_pct: 63.4, destination: "Bréhan", etat: "en_route", maintenant: 1_760_000_000_000 });
  assert.deepEqual(m, { v: 1, t: 1_760_000_000_000, etat: "en_route", lat: 48.12346, lon: -2.98765, cap: 92, kmh: 87, arrivee: 1_760_000_123_457, restant_km: 42, batterie: 63, destination: "Bréhan" });
  assert.deepEqual(p.lireMessage(JSON.stringify(m)), m);
  // Cap inconnu à l'arrêt : absent plutôt qu'inventé.
  assert.equal(p.messagePosition({ lat: 48, lon: -2, cap: NaN, etat: "a_la_borne" }).cap, null);
  assert.equal(p.lireMessage("bonjour"), null);
  assert.equal(p.lireMessage(JSON.stringify({ v: 2, t: 1, etat: "en_route" })), null);
});

test("position en direct : envoi au relais, lecture des messages dans l'ordre", async () => {
  const sujet = p.creerSujet();
  const appels = installerFetch((url, options) => {
    if (options.method === "POST") return { json: { id: "x" } };
    const lignes = [
      { id: "a1", event: "message", message: JSON.stringify(p.messagePosition({ lat: 48, lon: -2, etat: "en_route", maintenant: 1000 })) },
      { id: "a2", event: "open" },
      { id: "a3", event: "message", message: "pas un message de l'appli" },
      { id: "a4", event: "message", message: JSON.stringify(p.messagePosition({ lat: 48.1, lon: -2.1, etat: "arrive", maintenant: 2000 })) },
    ];
    return { texte: lignes.map((l) => JSON.stringify(l)).join("\n") + "\n" };
  });
  assert.equal(await p.publier(sujet, p.messagePosition({ lat: 48, lon: -2, etat: "en_route" })), true);
  assert.equal(appels[0].url, `https://ntfy.sh/${sujet}`);
  const recus = await p.lireMessages(sujet, "12h");
  assert.deepEqual(recus.map((r) => [r.id, r.message.etat]), [["a1", "en_route"], ["a4", "arrive"]]);
  assert.ok(appels[1].url.endsWith(`/${sujet}/json?poll=1&since=12h`));
});

test("position en direct : relais injoignable, l'envoi échoue sans faire planter le guidage", async () => {
  installerFetch(() => {
    throw new Error("hors ligne");
  });
  assert.equal(await p.publier(p.creerSujet(), { v: 1 }), false);
});
