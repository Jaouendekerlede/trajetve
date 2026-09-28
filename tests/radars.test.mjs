import { test } from "node:test";
import assert from "node:assert/strict";
import { LABELS_TYPE_RADAR, lireRadarsGouvCsv } from "../js/osm-route.js";
import { radarsSurTrace } from "../js/alertes-route.js";

test("radars officiels : les sept types du jeu de données sont reconnus et conservés", () => {
  const types = ["ETF", "ETD", "ETT", "ETU", "ETVM", "ETFR", "ETPN"];
  const lignes = [
    "Latitude;Longitude;Type de radar",
    ...types.map((type, index) => `${48 + index / 100};2;${type}`),
  ];
  const radars = lireRadarsGouvCsv(lignes.join("\n"));

  assert.deepEqual(radars.map((radar) => radar.type), types);
  assert.equal(radars.length, types.length);
  for (const type of types) {
    assert.ok(LABELS_TYPE_RADAR[type], `libellé manquant pour ${type}`);
  }
});

test("radars de feu rouge : tolérance de géolocalisation élargie au carrefour seulement", () => {
  const coords = [[0, 0], [0.01, 0]];
  const cum = [0, 1112];
  const radars = [
    { lat: 0.0007, lon: 0.005, type: "ETFR" },
    { lat: 0.0007, lon: 0.005, type: "ETF" },
  ];

  assert.deepEqual(radarsSurTrace(radars, coords, cum).map((radar) => radar.type), ["ETFR"]);
});
