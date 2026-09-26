import { test } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage } from "./aide.mjs";

installerLocalStorage();
const a = await import("../js/alertes-route.js");
const s = await import("../js/storage.js");

// Route droite vers l'est, un point tous les 100 m, sur 10 km.
const N = 101;
const coords = Array.from({ length: N }, (_, i) => [-1.68 + i * 0.0013457, 48.1]);
const cum = coords.map((_, i) => i * 100);

test("zones de danger : longueur légale selon la route, sans le point exact", () => {
  assert.equal(a.longueurZoneDanger(130), 4000);
  assert.equal(a.longueurZoneDanger(90), 2000);
  assert.equal(a.longueurZoneDanger(50), 300);
  const limites = coords.map(() => 90);
  const radar = { lat: 48.1002, lon: coords[60][0] }; // 22 m à côté, à 6 km
  const z = a.zonesDeDanger([radar, { lat: 48.11, lon: coords[30][0] }], coords, cum, limites);
  assert.equal(z.length, 1, "le radar à 1 km du tracé est sur une autre route");
  assert.ok(Math.abs(z[0].debut - 4400) < 5 && Math.abs(z[0].fin - 6400) < 5);
  assert.equal(z[0].limite, 90);
  // Deux radars proches : une seule zone.
  const z2 = a.zonesDeDanger([{ lat: 48.1, lon: coords[60][0] }, { lat: 48.1, lon: coords[65][0] }], coords, cum, limites);
  assert.equal(z2.length, 1);
});

test("feux : « au deuxième feu », un seul par carrefour, rien sans feu au virage", () => {
  const feu = (i, decalage = 0) => ({ lat: 48.1 + decalage, lon: coords[i][0] });
  // Carrefour à 3 km (deux feux, un par voie d'arrivée), carrefour du virage à 5 km.
  const positions = a.positionsSurTrace([feu(30), feu(30, 0.0001), feu(50), feu(80, 0.01)], coords, cum, 20);
  assert.equal(positions.length, 3, "le feu à 1 km du tracé est ignoré");
  assert.equal(a.compterFeux(positions, 5000, 0), 2);
  assert.equal(a.compterFeux(positions, 5000, 3500), 1);
  assert.equal(a.compterFeux(positions, 7000, 5500), null, "pas de feu au virage");
  assert.equal(a.messageAvecFeu("Tournez à gauche sur Rue X", 2), "Au deuxième feu, tournez à gauche sur Rue X");
  assert.equal(a.messageAvecFeu("Tournez à gauche", null), "Tournez à gauche");
  assert.equal(a.messageAvecFeu("Tournez à gauche", 5), "Tournez à gauche");
});

test("routes coupées marquées : gardées, limitées à 5, converties pour TomTom", () => {
  localStorage.clear();
  for (let i = 0; i < 7; i++) s.ajouterZoneEvitee(48.1 + i * 0.01, -1.68);
  assert.equal(s.listerZonesEvitees().length, 5);
  const r = s.rectanglesZonesEvitees();
  assert.equal(r.length, 5);
  assert.ok(r[0].southWestCorner.latitude < r[0].northEastCorner.latitude);
  s.retirerZoneEvitee(s.listerZonesEvitees()[0].id);
  assert.equal(s.listerZonesEvitees().length, 4);
  // Incluses dans la sauvegarde (clé « trajetve_ »).
  assert.ok("trajetve_zones_evitees" in s.exporterDonnees().donnees);
});

test("itinéraire proposé : même chemin (trafic à jour) ou vraiment un autre", () => {
  // Même route légèrement décalée (4 m) : pas « différente ».
  const meme = coords.map(([lon, lat]) => [lon, lat + 0.00004]);
  assert.ok(a.partDifferente(meme, coords, cum) < 0.05);
  // Route parallèle à 1 km au nord : différente.
  const autre = coords.map(([lon, lat]) => [lon, lat + 0.009]);
  assert.ok(a.partDifferente(autre, coords, cum) > 0.9);
});
