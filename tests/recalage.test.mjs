// Situations difficiles pour le GPS, rejouées sur des traces fabriquées
// (aucune trace réelle). Chaque scénario compare, quand c'est utile, l'ancien
// calcul (point le plus proche, deux mesures pour recalculer) au nouveau, sur
// des résultats observables : sauts de position, faux recalculs, délai de
// détection. Ces tests ne remplacent pas un essai sur route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { qualiteMesure, recaler, evaluerHorsRoute, estimerProgression, niveauPrecision, candidatsSurRoute } from "../js/recalage.js";

// ── Outils : tracés en mètres autour de (48, -2), bruit reproductible ───────

const LAT0 = 48;
const LON0 = -2;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const versGeo = ([x, y]) => [LON0 + x / KX, LAT0 + y / KY];

// Tracé passant par ces sommets (mètres), un point tous les `pas` mètres.
function tracer(sommets, pas = 10) {
  const xy = [];
  for (let s = 0; s < sommets.length - 1; s++) {
    const [ax, ay] = sommets[s];
    const [bx, by] = sommets[s + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / pas));
    for (let k = 0; k < n; k++) xy.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  xy.push(sommets[sommets.length - 1]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { coords: xy.map(versGeo), cum, xy, total: cum[cum.length - 1] };
}

// Position (mètres) à `offset` mètres du début du tracé, et cap de la route.
function surTrace(route, offset) {
  const { xy, cum } = route;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < offset) i++;
  const t = Math.max(0, Math.min(1, (offset - cum[i]) / (cum[i + 1] - cum[i])));
  const [ax, ay] = xy[i];
  const [bx, by] = xy[i + 1];
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay), cap: ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360 };
}

function aleatoire(graine) {
  let a = graine;
  const uniforme = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniforme() + 1e-12)) * Math.cos(2 * Math.PI * uniforme());
}

const T0 = 1_760_000_000_000;

// Mesures d'une voiture roulant sur le tracé à `vitesse` m/s, une par seconde,
// avec une erreur gaussienne d'écart-type `bruit` mètres.
function rouler(route, { vitesse, bruit, precision = Math.max(5, bruit * 1.5), debut = 0, fin = route.total, graine = 1 }) {
  const g = aleatoire(graine);
  const mesures = [];
  for (let s = 0, offset = debut; offset <= fin; s++, offset += vitesse) {
    const p = surTrace(route, offset);
    const [lon, lat] = versGeo([p.x + g() * bruit, p.y + g() * bruit]);
    mesures.push({ lat, lon, precision, vitesse, cap: p.cap, t: T0 + s * 1000, vrai: offset });
  }
  return mesures;
}

// Ancien calcul, gardé ici comme point de comparaison : point le plus proche
// autour du dernier indice, recherche sur tout le tracé au-delà de 150 m.
function ancienProjeter(route, lat, lon, depuis) {
  const n = route.coords.length - 1;
  const proche = (debut, fin) => candidatsSurRoute(route, lat, lon, debut, fin, Infinity).reduce((a, b) => (b.d < a.d ? b : a));
  if (depuis == null) return proche(0, n);
  const local = proche(Math.max(0, depuis - 40), Math.min(n, depuis + 500));
  return local.d > 150 ? proche(0, n) : local;
}

// Rejoue des mesures dans les deux calculs et compte ce qui se voit à l'écran.
function rejouer(route, mesures) {
  const bilan = { ancien: { sauts: 0, recalculs: 0, erreurMax: 0 }, nouveau: { sauts: 0, recalculs: 0, erreurMax: 0, rejets: 0, ambigus: 0 } };
  let idx = null;
  let offsetAncien = null;
  let horsAncien = 0;
  let precedent = null;
  let acceptee = null;
  let suiviQualite = {};
  let suiviHors = {};
  for (const m of mesures) {
    // Ancien : toute mesure est prise, deux de suite hors seuil recalculent.
    const a = ancienProjeter(route, m.lat, m.lon, idx);
    if (offsetAncien !== null && Math.abs(a.offset - offsetAncien - m.vitesse) > 200) bilan.ancien.sauts++;
    idx = a.i;
    offsetAncien = a.offset;
    bilan.ancien.erreurMax = Math.max(bilan.ancien.erreurMax, Math.abs(a.offset - m.vrai));
    horsAncien = a.d > Math.max(40, m.precision * 1.5) && m.vitesse > 2 ? horsAncien + 1 : 0;
    if (horsAncien === 2) bilan.ancien.recalculs++;

    const q = qualiteMesure(m, acceptee, m.t, suiviQualite);
    suiviQualite = q.suivi;
    if (!q.valide) {
      bilan.nouveau.rejets++;
      continue;
    }
    acceptee = m;
    const r = recaler(route, m, precedent);
    if (precedent && Math.abs(r.offset - precedent.offset - m.vitesse * ((m.t - precedent.t) / 1000)) > 200) bilan.nouveau.sauts++;
    if (r.ambigu) bilan.nouveau.ambigus++;
    bilan.nouveau.erreurMax = Math.max(bilan.nouveau.erreurMax, Math.abs(r.offset - m.vrai));
    precedent = r;
    const h = evaluerHorsRoute(suiviHors, { d: r.d, precision: m.precision, vitesse: m.vitesse, t: m.t, niveau: q.niveau });
    if (h.confirme && !suiviHors.confirme) bilan.nouveau.recalculs++;
    suiviHors = h;
  }
  return bilan;
}

// ── Qualité des mesures ─────────────────────────────────────────────────────

test("qualité : précision bonne, faible, mauvaise ou inconnue", () => {
  assert.equal(niveauPrecision(8), "bon");
  assert.equal(niveauPrecision(35), "faible");
  assert.equal(niveauPrecision(120), "mauvais");
  assert.equal(niveauPrecision(undefined), "faible", "précision inconnue : jamais présentée comme bonne");
});

test("qualité : mesure ancienne rejetée, horloge décalée tolérée", () => {
  const p = { lat: 48, lon: -2, precision: 10, t: T0 };
  // Horloge du GPS en retard constant de 5 minutes : la première mesure sert de repère.
  let q = qualiteMesure(p, null, T0 + 300_000, {});
  assert.equal(q.valide, true);
  q = qualiteMesure({ ...p, t: T0 + 1000 }, p, T0 + 301_000, q.suivi);
  assert.equal(q.valide, true, "décalage constant : mesure fraîche");
  assert.ok(q.age_s < 1);
  // Une mesure livrée 15 s après avoir été prise : périmée.
  q = qualiteMesure({ ...p, t: T0 + 2000 }, { ...p, t: T0 + 1000 }, T0 + 317_000, q.suivi);
  assert.equal(q.valide, false);
  assert.match(q.raison, /vieille de 15 s/);
});

test("qualité : coordonnées invalides et mesures dans le désordre rejetées", () => {
  assert.equal(qualiteMesure({ lat: NaN, lon: -2, t: T0 }, null, T0).valide, false);
  assert.equal(qualiteMesure({ lat: 95, lon: -2, t: T0 }, null, T0).valide, false);
  const avant = { lat: 48, lon: -2, precision: 10, t: T0 + 5000 };
  const q = qualiteMesure({ lat: 48, lon: -2, precision: 10, t: T0 + 3000 }, avant, T0 + 5000, { decalageHorloge: 0 });
  assert.equal(q.valide, false);
  assert.match(q.raison, /désordre/);
});

test("qualité : un saut impossible est écarté, deux mesures concordantes font foi", () => {
  const a = { lat: 48, lon: -2, precision: 10, t: T0 };
  const [lonLoin, latLoin] = versGeo([900, 0]);
  const loin = { lat: latLoin, lon: lonLoin, precision: 10, t: T0 + 1000 };
  let q = qualiteMesure(loin, a, T0 + 1000, { decalageHorloge: 0 });
  assert.equal(q.valide, false, "900 m en une seconde");
  assert.match(q.raison, /saut de 900 m/);
  // La mesure suivante confirme le nouvel endroit : c'était la précédente qui était fausse.
  const [lon2, lat2] = versGeo([920, 0]);
  q = qualiteMesure({ lat: lat2, lon: lon2, precision: 10, t: T0 + 2000 }, a, T0 + 2000, q.suivi);
  assert.equal(q.valide, true);
  // Après 30 s sans mesure (tunnel), un grand déplacement est normal.
  assert.equal(qualiteMesure({ ...loin, t: T0 + 40_000 }, a, T0 + 40_000, { decalageHorloge: 0 }).valide, true);
});

test("qualité : le filtre ne bloque jamais le guidage (trois rejets de suite au plus)", () => {
  // Une mesure horodatée par erreur une minute dans le futur a été acceptée…
  const future = { lat: 48, lon: -2, precision: 10, t: T0 + 60_000 };
  let suivi = { decalageHorloge: -60_000 };
  const resultats = [];
  // … toutes les suivantes, correctes, paraissent alors « dans le désordre ».
  for (let s = 1; s <= 5; s++) {
    const q = qualiteMesure({ lat: 48, lon: -2 + s * 0.0001, precision: 10, t: T0 + s * 1000 }, future, T0 + s * 1000, suivi);
    suivi = q.suivi;
    resultats.push(q.valide);
  }
  assert.deepEqual(resultats.slice(0, 4), [false, false, false, true], "la quatrième est reprise");
});

// ── Recalage ────────────────────────────────────────────────────────────────

test("route droite, bon signal : suivi régulier, aucun saut ni recalcul", () => {
  const route = tracer([[0, 0], [3000, 0]]);
  const b = rejouer(route, rouler(route, { vitesse: 25, bruit: 5 }));
  assert.deepEqual([b.nouveau.sauts, b.nouveau.recalculs, b.nouveau.rejets], [0, 0, 0]);
  assert.ok(b.nouveau.erreurMax < 20, `erreur le long du tracé : ${b.nouveau.erreurMax.toFixed(1)} m`);
});

test("chaussées séparées (aller puis retour à 20 m) : pas de saut sur la chaussée opposée", (t) => {
  // 2 km vers l'est, demi-tour, puis retour sur la chaussée d'en face.
  const route = tracer([[0, 0], [2000, 0], [2000, 20], [0, 20]]);
  const aller = rouler(route, { vitesse: 25, bruit: 12, fin: 1900, graine: 7 });
  const b = rejouer(route, aller);
  t.diagnostic(`ancien calcul : ${b.ancien.sauts} sauts, erreur maximale ${b.ancien.erreurMax.toFixed(0)} m ; nouveau : ${b.nouveau.sauts} saut, erreur maximale ${b.nouveau.erreurMax.toFixed(0)} m, ${b.nouveau.ambigus} mesures ambiguës sur ${aller.length}`);
  assert.ok(b.ancien.sauts > 0, `l'ancien calcul sautait sur la chaussée retour (${b.ancien.sauts} sauts)`);
  assert.equal(b.nouveau.sauts, 0);
  assert.ok(b.nouveau.erreurMax < 60, `erreur maximale ${b.nouveau.erreurMax.toFixed(0)} m (ancien : ${b.ancien.erreurMax.toFixed(0)} m)`);
});

test("chaussées séparées : le retour est bien suivi après le demi-tour", () => {
  const route = tracer([[0, 0], [2000, 0], [2000, 20], [0, 20]]);
  const b = rejouer(route, rouler(route, { vitesse: 20, bruit: 8, graine: 3 }));
  assert.equal(b.nouveau.sauts, 0);
  assert.ok(b.nouveau.erreurMax < 60, `erreur maximale ${b.nouveau.erreurMax.toFixed(0)} m`);
});

test("échangeur en boucle (le tracé se recroise) : la suite du trajet est gardée", () => {
  // Boucle : on passe deux fois au même endroit, à angle droit.
  const route = tracer([[0, 0], [600, 0], [600, 300], [300, 300], [300, -400]]);
  const b = rejouer(route, rouler(route, { vitesse: 14, bruit: 8, graine: 5 }));
  assert.equal(b.nouveau.sauts, 0);
  assert.ok(b.nouveau.erreurMax < 60, `erreur maximale ${b.nouveau.erreurMax.toFixed(0)} m`);
});

test("rond-point : pas de saut en le parcourant", () => {
  const rayon = 20;
  const anneau = Array.from({ length: 19 }, (_, k) => [300 + rayon - rayon * Math.cos((k * Math.PI) / 12), -rayon * Math.sin((k * Math.PI) / 12)]);
  const route = tracer([[0, 0], ...anneau, [320, 300]], 5);
  const b = rejouer(route, rouler(route, { vitesse: 8, bruit: 6, graine: 9 }));
  assert.equal(b.nouveau.sauts, 0);
  assert.equal(b.nouveau.recalculs, 0);
});

test("à l'arrêt, cap du GPS instable : la position ne bouge pas", () => {
  const route = tracer([[0, 0], [1000, 0], [1000, 20], [0, 20]]);
  const g = aleatoire(11);
  const arret = surTrace(route, 500);
  let precedent = null;
  const offsets = [];
  for (let s = 0; s < 30; s++) {
    const [lon, lat] = versGeo([arret.x + g() * 4, arret.y + g() * 4]);
    precedent = recaler(route, { lat, lon, precision: 8, vitesse: 0, cap: (s * 97) % 360, t: T0 + s * 1000 }, precedent);
    offsets.push(precedent.offset);
  }
  assert.ok(Math.max(...offsets) - Math.min(...offsets) < 25, `dispersion ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(0)} m`);
});

test("saut lointain le long du tracé : attendu une seconde mesure avant de l'accepter", () => {
  // Deux passages proches du tracé, séparés de 4 km de route.
  const route = tracer([[0, 0], [2000, 0], [2000, 60], [0, 60]]);
  const ici = surTrace(route, 500);
  let r = recaler(route, { lat: versGeo([ici.x, ici.y])[1], lon: versGeo([ici.x, ici.y])[0], precision: 10, vitesse: 20, cap: 90, t: T0 }, null);
  assert.ok(Math.abs(r.offset - 500) < 5);
  // La mesure suivante tombe pile sur l'autre passage, en sens inverse.
  const la = surTrace(route, 3540);
  const mesure = (t) => ({ lat: versGeo([la.x, la.y])[1], lon: versGeo([la.x, la.y])[0], precision: 10, vitesse: 20, cap: 270, t });
  r = recaler(route, mesure(T0 + 1000), r);
  assert.ok(r.offset < 700, "une seule mesure : on reste sur la suite logique");
  assert.equal(r.confiance, "basse");
  assert.ok(r.attente);
  r = recaler(route, mesure(T0 + 2000), r);
  assert.ok(Math.abs(r.offset - 3540) < 30, `seconde mesure concordante : saut accepté (${r.offset.toFixed(0)} m)`);
});

// ── Hors itinéraire ─────────────────────────────────────────────────────────

test("vraie sortie d'itinéraire, bon signal : détectée en deux mesures après le seuil", () => {
  const route = tracer([[0, 0], [3000, 0]]);
  let suivi = {};
  let precedent = null;
  let detectee = null;
  for (let s = 0; s < 20 && detectee === null; s++) {
    // La voiture quitte la route à angle droit à 15 m/s à partir de x = 500.
    const [lon, lat] = versGeo([500, s * 15]);
    precedent = recaler(route, { lat, lon, precision: 8, vitesse: 15, cap: 0, t: T0 + s * 1000 }, precedent);
    suivi = evaluerHorsRoute(suivi, { d: precedent.d, precision: 8, vitesse: 15, t: T0 + s * 1000 });
    if (suivi.confirme) detectee = s;
  }
  // Seuil de 40 m franchi à la 3e seconde (45 m), confirmé à la 4e (60 m).
  assert.equal(detectee, 4);
});

test("signal dégradé : deux mesures écartées ne déclenchent plus de recalcul", () => {
  const route = tracer([[0, 0], [3000, 0]]);
  const mesures = rouler(route, { vitesse: 20, bruit: 3, precision: 30, graine: 2 });
  // Deux mesures de suite à 70 m de côté (immeubles, arbres), précision annoncée 30 m.
  for (const k of [40, 41]) {
    const p = surTrace(route, mesures[k].vrai);
    [mesures[k].lon, mesures[k].lat] = versGeo([p.x, p.y + 70]);
  }
  const b = rejouer(route, mesures);
  assert.equal(b.ancien.recalculs, 1, "l'ancien calcul recalculait");
  assert.equal(b.nouveau.recalculs, 0);
});

test("signal dégradé : une vraie sortie est quand même détectée, un peu plus tard", () => {
  let suivi = {};
  let detectee = null;
  for (let s = 0; s < 30 && detectee === null; s++) {
    suivi = evaluerHorsRoute(suivi, { d: s * 15, precision: 30, vitesse: 15, t: T0 + s * 1000 });
    if (suivi.confirme) detectee = s;
  }
  // Seuil de 45 m franchi à s = 4 ; trois mesures et trois secondes : s = 7.
  assert.equal(detectee, 7);
});

test("hors itinéraire : rien à l'arrêt, et retour franc nécessaire pour annuler", () => {
  assert.equal(evaluerHorsRoute({ compte: 1, depuis: T0 }, { d: 200, precision: 10, vitesse: 0.5, t: T0 + 1000 }).compte, 0);
  // Entre 70 % et 100 % du seuil (28 à 40 m) : le compte reste où il est.
  const zone = evaluerHorsRoute({ compte: 1, depuis: T0 }, { d: 35, precision: 10, vitesse: 10, t: T0 + 1000 });
  assert.deepEqual([zone.compte, zone.confirme], [1, false]);
  assert.equal(evaluerHorsRoute({ compte: 1, depuis: T0 }, { d: 20, precision: 10, vitesse: 10, t: T0 + 1000 }).compte, 0);
});

// ── Tunnel ──────────────────────────────────────────────────────────────────

test("tunnel : progression estimée 30 s au plus, puis position perdue", () => {
  const dernier = { offset: 1000, vitesse: 25, t: T0, d: 5, precision: 8 };
  assert.equal(estimerProgression(dernier, T0 + 2000, 9000).etat, "suivi");
  const a10 = estimerProgression(dernier, T0 + 10_000, 9000);
  assert.deepEqual([a10.etat, a10.offset], ["estime", 1250]);
  const a25 = estimerProgression(dernier, T0 + 25_000, 9000);
  assert.ok(a25.incertitude_m > a10.incertitude_m, "l'incertitude grandit avec le temps");
  const a40 = estimerProgression(dernier, T0 + 40_000, 9000);
  assert.deepEqual([a40.etat, a40.offset], ["perdu", 1750], "arrêt de l'estimation après 30 s");
  assert.equal(estimerProgression(dernier, T0 + 20_000, 1200).offset, 1200, "jamais au-delà de l'arrivée");
});

test("tunnel : pas d'estimation si la voiture était à l'arrêt ou hors du tracé", () => {
  assert.equal(estimerProgression({ offset: 1000, vitesse: 0.5, t: T0, d: 5, precision: 8 }, T0 + 10_000, 9000).etat, "fige");
  assert.equal(estimerProgression({ offset: 1000, vitesse: 20, t: T0, d: 80, precision: 8 }, T0 + 10_000, 9000).etat, "fige");
});

test("sortie de tunnel : reprise sans saut ni recalcul", () => {
  const route = tracer([[0, 0], [5000, 0]]);
  const mesures = rouler(route, { vitesse: 25, bruit: 6, graine: 4 });
  // 25 secondes sans aucune mesure (625 m de tunnel).
  const avecTunnel = mesures.filter((m) => m.vrai < 1500 || m.vrai > 2125);
  const b = rejouer(route, avecTunnel);
  assert.deepEqual([b.nouveau.sauts, b.nouveau.recalculs, b.nouveau.rejets], [0, 0, 0]);
});
