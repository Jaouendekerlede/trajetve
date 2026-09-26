import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage, installerFetch } from "./aide.mjs";

installerLocalStorage();
const s = await import("../js/storage.js");
const r = await import("../js/restauration.js");
const { carresSurTrace, traceTraverseCarres } = await import("../js/geo.js");
const { calculerItineraireTomTom } = await import("../js/tomtom.js");

const JOUR_MS = 24 * 60 * 60 * 1000;
const ADRESSE = "https://exemple.github.io/trajetve/index.html?x=1#ancien";

beforeEach(() => localStorage.clear());

test("lien de restauration : toutes les données reviennent, sans passer par le serveur", async () => {
  localStorage.setItem("trajetve_api_keys", JSON.stringify({ tomtom: "CLE-TT", openChargeMap: "CLE-OCM" }));
  s.sauverReglages({ theme: "clair" });
  for (let i = 0; i < 200; i++) s.ajouterAuJournal({ lieu: `Borne ${i}`, kwh: 30, cout_eur: 6, source: "manuel" });
  localStorage.setItem("tve_navigation_en_cours", "{}"); // propre au téléphone

  const { lien } = await r.creerLienRestauration(ADRESSE);
  assert.ok(lien.startsWith("https://exemple.github.io/trajetve/index.html#restaurer="));
  // Les clés sont après « # » (jamais envoyé au serveur) et pas en clair.
  assert.ok(!lien.includes("CLE-TT"));
  assert.ok(/^[A-Za-z0-9_-]+$/.test(lien.split("#restaurer=")[1]));

  localStorage.clear();
  const hash = lien.slice(lien.indexOf("#"));
  assert.ok(r.estLienRestauration(hash));
  s.importerDonnees(await r.lireLienRestauration(hash));
  assert.equal(JSON.parse(localStorage.getItem("trajetve_api_keys")).tomtom, "CLE-TT");
  assert.equal(s.lireReglages().theme, "clair");
  assert.equal(s.listerJournal().length, 200);
  assert.equal(localStorage.getItem("tve_navigation_en_cours"), null);
});

test("lien de restauration abîmé (coupé) : erreur, rien d'importé", async () => {
  localStorage.setItem("trajetve_api_keys", JSON.stringify({ tomtom: "CLE-TT" }));
  const { lien } = await r.creerLienRestauration(ADRESSE);
  const coupe = lien.slice(lien.indexOf("#"), -12);
  await assert.rejects(r.lireLienRestauration(coupe));
  assert.equal(await r.lireLienRestauration("#autre"), null);
});

test("rappel de sauvegarde : jamais envoyé, puis seulement si modifié depuis un mois", async () => {
  const t0 = Date.UTC(2026, 8, 25);
  assert.equal(r.rappelSauvegardeNecessaire(t0), false, "rien à sauvegarder sans clés");
  localStorage.setItem("trajetve_api_keys", JSON.stringify({ tomtom: "CLE-TT" }));
  assert.equal(r.rappelSauvegardeNecessaire(t0), true, "jamais envoyé");

  r.reporterRappel(t0);
  assert.equal(r.rappelSauvegardeNecessaire(t0 + 3 * JOUR_MS), false, "« plus tard » : 7 jours");
  assert.equal(r.rappelSauvegardeNecessaire(t0 + 8 * JOUR_MS), true);

  const { empreinte } = await r.creerLienRestauration(ADRESSE);
  r.noterLienEnvoye(empreinte, t0);
  assert.equal(r.rappelSauvegardeNecessaire(t0 + 60 * JOUR_MS), false, "rien n'a changé");
  s.sauverReglages({ theme: "sombre" });
  assert.equal(r.rappelSauvegardeNecessaire(t0 + 10 * JOUR_MS), false, "modifié mais envoyé récemment");
  assert.equal(r.rappelSauvegardeNecessaire(t0 + 31 * JOUR_MS), true);
});

test("route barrée : carrés sur le tracé devant la voiture, pas sur elle", () => {
  // Route tout droit vers le nord, un point tous les ~111 m.
  const coords = Array.from({ length: 10 }, (_, i) => [-1.68, 48.1 + i * 0.001]);
  const cum = coords.map((_, i) => i * 111.2);
  const carres = carresSurTrace(coords, cum, 100, [40, 120, 200, 280], 25);
  assert.equal(carres.length, 4);
  for (const c of carres) {
    assert.ok(c.southWestCorner.latitude < c.northEastCorner.latitude);
    assert.ok(c.southWestCorner.longitude < -1.68 && c.northEastCorner.longitude > -1.68);
  }
  // La voiture (à 100 m, latitude ~48.1009) reste hors du premier carré.
  assert.ok(carres[0].southWestCorner.latitude > 48.1 + 100 / 111200);
  // Près de l'arrivée : seulement les carrés encore sur le tracé.
  assert.equal(carresSurTrace(coords, cum, 900, [40, 120, 200, 280], 25).length, 1);
});

test("TomTom : les zones évitées partent dans la requête (POST avoidAreas)", async () => {
  const route = { summary: { lengthInMeters: 1000, travelTimeInSeconds: 60 }, legs: [{ summary: {}, points: [{ latitude: 48.1, longitude: -1.68 }, { latitude: 48.11, longitude: -1.68 }] }], sections: [] };
  const appels = installerFetch(() => ({ json: { routes: [route] } }));
  const zones = [{ southWestCorner: { latitude: 48.1, longitude: -1.69 }, northEastCorner: { latitude: 48.101, longitude: -1.67 } }];
  const res = await calculerItineraireTomTom("CLE", 48.1, -1.68, 48.11, -1.68, { zonesEvitees: zones });
  assert.equal(res.erreur, null);
  assert.equal(appels[0].options.method, "POST");
  assert.deepEqual(JSON.parse(appels[0].options.body).avoidAreas.rectangles, zones);
  // Sans zone ni tracé : simple GET.
  await calculerItineraireTomTom("CLE", 48.1, -1.68, 48.11, -1.68, {});
  assert.equal(appels[1].options.method, undefined);
});

test("route barrée : détecte si le nouveau tracé passe encore par l'endroit", () => {
  const carre = [{ southWestCorner: { latitude: 48.1004, longitude: -1.6805 }, northEastCorner: { latitude: 48.1006, longitude: -1.6795 } }];
  // Deux points éloignés de part et d'autre du carré : le segment le traverse.
  assert.equal(traceTraverseCarres([[-1.68, 48.1], [-1.68, 48.101]], carre), true);
  // Détour par l'est.
  assert.equal(traceTraverseCarres([[-1.68, 48.1], [-1.678, 48.1], [-1.678, 48.101], [-1.68, 48.101]], carre), false);
});

test("flèche de manœuvre : morceau de route autour du virage et pointe dans le sens de sortie", async () => {
  const { flecheManoeuvre } = await import("../js/geo.js");
  // Tout droit vers le nord sur 100 m, puis à droite (est) sur 100 m.
  const coords = [[-1.68, 48.1], [-1.68, 48.1009], [-1.67865, 48.1009]];
  const cum = [0, 100, 200];
  const f = flecheManoeuvre(coords, cum, 100);
  const fin = f.ligne[f.ligne.length - 1];
  assert.ok(f.ligne.length > 3, "virage arrondi (lissé)");
  assert.ok(f.ligne[0][1] < 48.1009 && fin[0] > -1.68, "commence avant le virage, finit après");
  // Pointe : le sommet est à l'est du bout de la ligne.
  assert.ok(f.pointe[1][0] > fin[0]);
  assert.ok(f.pointe[0][1] > f.pointe[2][1], "base de la pointe perpendiculaire (nord-sud)");
  assert.equal(flecheManoeuvre(coords, cum, 400), null, "au-delà de la route");
});

test("tracé recalé sur la route dessinée (rond-point), sans sauter sur une rue qui croise", async () => {
  const { densifier, recalerSurRoutes } = await import("../js/geo.js");
  // Route dessinée : vers l'est à la latitude 48.1000 ; tracé TomTom 6 m plus au nord.
  const route = [[[-1.70, 48.1], [-1.60, 48.1]]];
  const rueQuiCroise = [[[-1.65, 48.09], [-1.65, 48.11]]];
  const trace = densifier([[-1.66, 48.100054], [-1.64, 48.100054]], 50);
  assert.ok(trace.length > 20);
  const r = recalerSurRoutes(trace, [...route, ...rueQuiCroise], 14);
  assert.ok(r.every(([, lat]) => Math.abs(lat - 48.1) < 1e-7), "tous les points sur la route dessinée");
  // Trop loin (30 m) : pas de recalage.
  const loin = recalerSurRoutes([[-1.65, 48.10027]], route, 14);
  assert.equal(loin[0][1], 48.10027);
});
