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
  assert.equal(zoom(60, 400, liste).zoom, 16.65, "encore loin : zoom de la vitesse (60 km/h)");
  assert.equal(zoom(60, 800, liste).zoom, 19, "200 m avant");
  assert.equal(zoom(20, 1100, liste).zoom, 19, "dans le rond-point (100 m après l'entrée)");
  assert.equal(zoom(40, 1200, liste).manoeuvre, null, "sorti du rond-point");
});

test("sortie d'autoroute : dès la voie de décélération, puis sur la bretelle", () => {
  const liste = [instr(5000, "TAKE_EXIT")];
  assert.equal(zoom(130, 3000, liste).zoom, 14.6, "autoroute : large");
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

test("hors manœuvre : zoom progressif selon la vitesse, sans bouger pour un rien", () => {
  const { zoomPourVitesse } = mod;
  assert.deepEqual([10, 20, 50, 80, 110, 130, 160].map(zoomPourVitesse), [18, 18, 17, 16, 15, 14.6, 14.6]);
  assert.ok(zoomPourVitesse(130) < zoomPourVitesse(110), "le champ s'élargit encore après 110 km/h");
  // 52 km/h avec un zoom de 17 : la cible (16,95) est trop proche pour bouger.
  assert.equal(zoom(52, 0, [], [], 17).zoom, 17);
  assert.equal(zoom(65, 0, [], [], 17).zoom, 16.5);
  assert.equal(zoom(120, 0, [], [], NaN).zoom, 14.8);
});

// Rejoue une suite de vitesses (une par seconde) et rend les zooms obtenus.
function rouler(vitesses, { limite = null, instructions = [], depart = 0 } = {}) {
  const { vitessePourZoom } = mod;
  let suivi = null;
  let zoomActuel = NaN;
  let enManoeuvre = false;
  let offset = depart;
  return vitesses.map((kmh, s) => {
    suivi = vitessePourZoom(suivi, { kmh, t: s * 1000, limite });
    offset += (Number.isFinite(kmh) ? kmh : suivi.kmh) / 3.6;
    const z = zoomNavigation({ kmh: suivi.kmh, kmhZoom: suivi.kmhZoom, offset, instructions, zoomActuel, enManoeuvre });
    zoomActuel = z.zoom;
    enManoeuvre = !!z.manoeuvre;
    return z.zoom;
  });
}
const changements = (zooms) => zooms.filter((z, i) => i > 0 && z !== zooms[i - 1]).length;
const sautMax = (zooms) => Math.max(...zooms.slice(1).map((z, i) => Math.abs(z - zooms[i])));

test("accélération puis ralentissement : la vue s'élargit puis se resserre, sans à-coup", () => {
  const montee = Array.from({ length: 40 }, (_, s) => Math.min(130, s * 4));
  const descente = Array.from({ length: 40 }, (_, s) => Math.max(30, 130 - s * 4));
  const zooms = rouler([...montee, ...Array(20).fill(130), ...descente, ...Array(20).fill(30)]);
  assert.equal(zooms[0], 18);
  assert.ok(Math.min(...zooms) <= 14.8, `vue la plus large : ${Math.min(...zooms)}`);
  assert.ok(zooms[zooms.length - 1] >= 17.4, `retour à ${zooms[zooms.length - 1]} à 30 km/h`);
  // La cible bouge par pas de 0,2 au moins ; la caméra lisse ensuite ce pas à l'écran.
  assert.ok(sautMax(zooms) <= 0.4, `plus grand changement d'une seconde à l'autre : ${sautMax(zooms)}`);
});

test("accélération franche (0 à 100 km/h en 8 s) : le zoom suit en quelques secondes", () => {
  const zooms = rouler([...Array.from({ length: 9 }, (_, s) => s * 12.5), ...Array(8).fill(100)]);
  // 100 km/h correspond à un zoom de 15,35 : atteint à 0,25 près 8 s après la fin de l'accélération.
  assert.ok(zooms[zooms.length - 1] <= 15.6, `zoom ${zooms[zooms.length - 1]} à 100 km/h`);
  assert.ok(zooms[8] < 17, `déjà élargi à la fin de l'accélération : ${zooms[8]}`);
});

test("arrêt à un feu puis redémarrage sur une route à 80 : la carte ne pompe pas", () => {
  const arret = [...Array(20).fill(80), ...Array.from({ length: 8 }, (_, s) => 80 - s * 10), ...Array(25).fill(0), ...Array.from({ length: 10 }, (_, s) => s * 8), ...Array(20).fill(80)];
  const avec = rouler(arret, { limite: 80 });
  // Plancher : 60 % de 80 = 48 km/h, soit un zoom d'environ 17,1 au plus près.
  assert.ok(Math.max(...avec) <= 17.2, `au plus près : ${Math.max(...avec)}`);
  // Pendant les 25 secondes à l'arrêt (hors 5 s de stabilisation), plus rien ne bouge.
  assert.equal(changements(avec.slice(33, 53)), 0, "zoom fixe à l'arrêt");
  const amplitude = (z) => Math.max(...z) - Math.min(...z);
  assert.ok(amplitude(avec) < amplitude(rouler(arret)) * 0.6, `amplitude ${amplitude(avec).toFixed(2)} contre ${amplitude(rouler(arret)).toFixed(2)} sans limitation connue`);
  // Sans limitation connue, l'ancien comportement demeure : la carte se rapproche à l'arrêt.
  assert.ok(Math.max(...rouler(arret)) >= 17.8);
});

test("bouchon sur autoroute : la vue reste large", () => {
  const zooms = rouler([...Array(15).fill(125), ...Array.from({ length: 10 }, (_, s) => 125 - s * 11), ...Array(30).fill(15)], { limite: 130 });
  // Plancher : 78 km/h, zoom d'environ 16,1.
  assert.ok(Math.max(...zooms) <= 16.2, `au plus près : ${Math.max(...zooms)}`);
});

test("vitesse aberrante ou absente : le zoom ne bouge pas", () => {
  const normal = Array(30).fill(50);
  const reference = rouler(normal);
  const pics = normal.slice();
  pics[12] = 240; // une mesure fausse
  pics[13] = NaN; // vitesse absente
  pics[20] = -5;
  const zooms = rouler(pics);
  assert.ok(sautMax(zooms) <= 0.2, `plus grand changement : ${sautMax(zooms)}`);
  assert.ok(Math.abs(zooms[zooms.length - 1] - reference[reference.length - 1]) <= 0.2);
});

test("perte du GPS : sans nouvelle vitesse, le zoom tient ; à la reprise, pas de saut", () => {
  const { vitessePourZoom } = mod;
  let suivi = null;
  for (let s = 0; s < 10; s++) suivi = vitessePourZoom(suivi, { kmh: 90, t: s * 1000 });
  const avant = suivi.kmh;
  // 25 secondes sans mesure, puis une vitesse plausible à la sortie du tunnel.
  suivi = vitessePourZoom(suivi, { kmh: 85, t: 35_000 });
  assert.ok(Math.abs(suivi.kmh - avant) < 6, `vitesse lissée ${suivi.kmh.toFixed(1)} après ${avant.toFixed(1)}`);
});

test("rond-point : zoom à sa taille, entre proche et très proche", () => {
  const { zoomRondPoint } = mod;
  assert.equal(zoomRondPoint(undefined), 19, "taille inconnue : au plus près, comme avant");
  const mini = zoomRondPoint(25);
  const moyen = zoomRondPoint(60);
  const grand = zoomRondPoint(220);
  assert.ok(mini >= moyen && moyen > grand, `${mini} ≥ ${moyen} > ${grand}`);
  assert.equal(mini, 19);
  assert.equal(grand, 18, "jamais plus large que 18 : le rond-point reste lisible");
  // Petit écran : la vue s'élargit un peu pour montrer la même chose.
  assert.ok(zoomRondPoint(60, 600) < zoomRondPoint(60, 900));
});

test("rond-point à plusieurs sorties : zoom adapté dès l'approche et pendant tout le tour", () => {
  const sortie1 = { ...instr(1000, "ROUNDABOUT_RIGHT", "ROUNDABOUT"), offsetSortie: 1030 };
  const sortie3 = { ...instr(1000, "ROUNDABOUT_LEFT", "ROUNDABOUT"), offsetSortie: 1140 };
  const z1 = zoom(40, 800, [sortie1]);
  const z3 = zoom(40, 800, [sortie3]);
  assert.equal(z1.manoeuvre, "rondpoint");
  assert.ok(z3.zoom < z1.zoom, `troisième sortie (${z3.zoom}) : vue plus large que première sortie (${z1.zoom})`);
  assert.equal(zoom(20, 1100, [sortie3]).zoom, z3.zoom, "même zoom pendant le tour");
  assert.equal(zoom(40, 400, [sortie3]).manoeuvre, null, "trop loin : zoom de vitesse");
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
