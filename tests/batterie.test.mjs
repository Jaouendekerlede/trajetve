import { test } from "node:test";
import assert from "node:assert/strict";
import { pctPrevuA, svgBatterie, tableauBatterie } from "../js/graphique-batterie.js";

const prevus = [{ km: 0, pct: 80 }, { km: 100, pct: 20 }, { km: 100, pct: 80 }, { km: 200, pct: 30 }];

test("batterie prévue interpolée, y compris à une borne (saut de charge)", () => {
  assert.equal(pctPrevuA(prevus, 50), 50);
  assert.equal(pctPrevuA(prevus, 100), 20);
  assert.equal(pctPrevuA(prevus, 150), 55);
  assert.equal(pctPrevuA(prevus, 999), 30);
});

test("graphique : une courbe prévue, points réels, repère de borne, tableau", () => {
  const reels = [{ km: 0, pct: 80 }, { km: 60, pct: 40 }];
  const svg = svgBatterie(prevus, reels, [{ km: 100, nom: "B" }], 60);
  assert.ok(svg.includes('class="prevue"') && svg.includes('class="reelle"'));
  assert.equal((svg.match(/class="point-reel"/g) || []).length, 2);
  assert.ok(svg.includes('data-max-km="200"'));
  const t = tableauBatterie(prevus, reels);
  assert.ok(t.includes("<td>60</td><td>44 %</td><td>40 %</td>"));
});
