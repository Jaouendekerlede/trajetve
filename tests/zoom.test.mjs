import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../js/zoom-nav.js";
const { typeManoeuvre, zoomNavigation } = mod;

const instr = (offset, manoeuvre, jonction = "REGULAR") => ({ offset, manoeuvre, type: "TURN", jonction });
const zoom = (kmh, offset, instructions, voies = [], zoomActuel = 15) => zoomNavigation({ kmh, offset, instructions, voies, zoomActuel });

test("types de manœuvre : rond-point, sortie, entrée, grand carrefour", () => {
  assert.equal(typeManoeuvre(instr(0, "ROUNDABOUT_RIGHT", "ROUNDABOUT")), "rondpoint");
  assert.equal(typeManoeuvre(instr(0, "TAKE_EXIT")), "sortie");
  assert.equal(typeManoeuvre(instr(0, "MOTORWAY_EXIT_RIGHT")), "sortie");
  assert.equal(typeManoeuvre({ ...instr(0, "KEEP_RIGHT", "BIFURCATION"), vitesseAvant: 130 }), "sortie");
  assert.equal(typeManoeuvre(instr(0, "ENTER_MOTORWAY")), "entree");
  assert.equal(typeManoeuvre(instr(0, "TURN_LEFT"), [{ offset: 10, lanes: [{}, {}, {}] }]), "carrefour");
  assert.equal(typeManoeuvre(instr(0, "TURN_LEFT"), [], instr(150, "TURN_RIGHT")), "carrefour");
  assert.equal(typeManoeuvre(instr(0, "TURN_LEFT"), [], instr(900, "TURN_RIGHT")), "simple");
});

test("rond-point : zoom au plus près avant, et pendant tout le tour", () => {
  const liste = [instr(1000, "ROUNDABOUT_LEFT", "ROUNDABOUT")];
  assert.equal(zoom(60, 400, liste).zoom, 16, "encore loin : zoom de la vitesse");
  assert.equal(zoom(60, 800, liste).zoom, 19, "200 m avant");
  assert.equal(zoom(20, 1100, liste).zoom, 19, "dans le rond-point (100 m après l'entrée)");
  assert.equal(zoom(40, 1200, liste).manoeuvre, null, "sorti du rond-point");
});

test("sortie d'autoroute : dès la voie de décélération, puis sur la bretelle", () => {
  const liste = [instr(5000, "TAKE_EXIT")];
  assert.equal(zoom(130, 3000, liste).zoom, 15, "autoroute : large");
  const decel = zoom(130, 4200, liste);
  assert.equal(decel.manoeuvre, "sortie", "800 m avant à 130 km/h");
  assert.equal(decel.zoom, 17);
  assert.equal(zoom(70, 5200, liste).zoom, 17.5, "sur la bretelle en ralentissant");
  assert.equal(zoom(40, 5400, liste).zoom, 18);
  assert.equal(zoom(40, 5600, liste).manoeuvre, null, "bretelle finie");
});

test("entrée d'autoroute : bretelle et voie d'accélération", () => {
  const liste = [instr(2000, "ENTER_MOTORWAY")];
  assert.equal(zoom(60, 1800, liste).zoom, 17.5);
  assert.equal(zoom(100, 2600, liste).zoom, 17, "voie d'accélération : encore zoomé");
  assert.equal(zoom(120, 2800, liste).manoeuvre, null, "inséré : retour au zoom autoroute");
});

test("le zoom le plus serré l'emporte (sortie qui finit sur un rond-point)", () => {
  const liste = [instr(1000, "TAKE_EXIT"), instr(1350, "ROUNDABOUT_RIGHT", "ROUNDABOUT")];
  assert.equal(zoom(45, 1200, liste).zoom, 19);
});

test("hors manœuvre : paliers de vitesse avec hystérésis", () => {
  assert.equal(zoom(52, 0, [], [], 17).zoom, 17, "52 km/h : pas encore assez au-dessus de 50");
  assert.equal(zoom(56, 0, [], [], 17).zoom, 16);
  assert.equal(zoom(120, 0, [], [], NaN).zoom, 15);
});

test("bretelles repérées par les limitations (voie express sans code « entrée »)", () => {
  const { vitessesAutour, typeManoeuvre: type } = mod;
  // 50 km/h jusqu'à 1000 m, bretelle sans limitation, puis 110 km/h dès 1300 m.
  const cum = Array.from({ length: 31 }, (_, i) => i * 100);
  const limites = cum.map((d) => (d < 1000 ? 50 : d < 1300 ? null : 110));
  const v = vitessesAutour(1000, cum, limites);
  assert.deepEqual(v, { avant: 50, apres: 110 });
  const rp = { offset: 1000, manoeuvre: "ROUNDABOUT_CROSS", jonction: "ROUNDABOUT", vitesseAvant: 50, vitesseApres: 110 };
  assert.equal(type(rp), "rondpoint");
  // Après le rond-point, la voie d'accélération reste zoomée.
  assert.equal(zoom(95, 1500, [rp]).manoeuvre, "entree");
  assert.equal(type({ offset: 0, manoeuvre: "KEEP_RIGHT", jonction: "REGULAR", vitesseAvant: 110, vitesseApres: 70 }), "sortie");
  assert.equal(type({ offset: 0, manoeuvre: "KEEP_RIGHT", jonction: "BIFURCATION", vitesseAvant: 30, vitesseApres: 30 }), "carrefour", "bifurcation en ville");
});
