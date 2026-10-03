import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lire = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("le numéro de version affiché suit celui du cache publié", () => {
  const cache = /CACHE_NOM = "trajetve-v(\d+)"/.exec(lire("service-worker.js"))[1];
  assert.equal(/ev-lien-centre">Version (\d+) :/.exec(lire("index.html"))[1], cache, "libellé « Version » du Profil (index.html)");
  assert.equal(/VERSION_ATTENDUE = (\d+);/.exec(lire("actualiser.html"))[1], cache, "VERSION_ATTENDUE (actualiser.html)");
});
