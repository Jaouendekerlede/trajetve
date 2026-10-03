import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const lire = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const sw = lire("service-worker.js");

test("le numéro de version affiché suit celui du cache publié", () => {
  const cache = /CACHE_NOM = "trajetve-v(\d+)"/.exec(sw)[1];
  assert.equal(/ev-lien-centre">Version (\d+) :/.exec(lire("index.html"))[1], cache, "libellé « Version » du Profil (index.html)");
  assert.equal(/VERSION_ATTENDUE = (\d+);/.exec(lire("actualiser.html"))[1], cache, "VERSION_ATTENDUE (actualiser.html)");
});

// L'appli est servie depuis la copie gardée par le téléphone : une
// modification publiée sans toucher au service worker n'arriverait jamais.
test("une modification de l'appli oblige à publier une nouvelle version", () => {
  const fichiers = [...sw.matchAll(/^\s*"\.\/([^"]+)",$/gm)].map((m) => m[1]);
  assert.ok(fichiers.length > 50, "liste FICHIERS_COQUILLE lue");
  const h = createHash("sha256");
  for (const f of fichiers) {
    // Fins de ligne neutralisées : Git les convertit selon le poste.
    h.update(f).update(/\.png$/.test(f) ? readFileSync(new URL(`../${f}`, import.meta.url)) : lire(f).replace(/\r\n/g, "\n"));
  }
  const empreinte = h.digest("hex").slice(0, 16);
  assert.equal(
    /EMPREINTE_COQUILLE = "([^"]+)"/.exec(sw)[1],
    empreinte,
    `l'appli a changé : augmente CACHE_NOM (et le libellé « Version ») puis mets EMPREINTE_COQUILLE = "${empreinte}" dans service-worker.js`,
  );
});
