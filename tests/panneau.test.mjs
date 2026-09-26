import { test } from "node:test";
import assert from "node:assert/strict";
import { classeNumero, estAutoroute, textesPanneau, svgCarrefour } from "../js/panneau-nav.js";

test("numéros de route aux couleurs des panneaux français", () => {
  assert.equal(classeNumero("A11"), "rouge");
  assert.equal(classeNumero("N165"), "rouge");
  assert.equal(classeNumero("D137"), "jaune");
  assert.equal(classeNumero("E50"), "vert");
  assert.equal(classeNumero("?"), "gris");
  assert.ok(estAutoroute("A81") && !estAutoroute("N136"));
});

test("panneau : rue en gros, numéros, sortie, direction, action courte", () => {
  const t = textesPanneau({ message: "Prenez la sortie 4 sur D31, direction Laval", rue: "", numeros: ["D31"], sortie: "4", direction: "Laval" });
  assert.equal(t.rue, "Laval", "sans nom de rue : la direction en gros");
  assert.equal(t.direction, "", "pas deux fois");
  assert.equal(t.action, "Prenez la sortie 4");
  assert.deepEqual(t.numeros, ["D31"]);
  assert.equal(t.sortie, "4");
  const u = textesPanneau({ message: "Tournez à droite sur Rue Ambroise Paré/D125, direction Centre", rue: "Rue Ambroise Paré", numeros: ["D125"], direction: "Centre" });
  assert.equal(u.rue, "Rue Ambroise Paré");
  assert.equal(u.action, "Tournez à droite");
  assert.equal(u.direction, "Centre");
});

test("dessin du carrefour : arrivée en bas, chemin blanc avec pointe", () => {
  // Arrivée par le sud vers le nord (cap 0), puis à droite (est).
  const c = [-1.68, 48.1];
  const chemin = [[-1.68, 48.0996], [-1.68, 48.1], [-1.6794, 48.1]];
  const routes = [[[-1.681, 48.1], [-1.679, 48.1]], [[-1.68, 48.0994], [-1.68, 48.1006]]];
  const svg = svgCarrefour(routes, chemin, c, 0);
  assert.ok(svg.startsWith("<svg") && svg.includes("<polygon"));
  const d = svg.match(/stroke="#fff"[^>]*/) && svg.match(/<path d="M([\d.]+) ([\d.]+)[^"]*" fill="none" stroke="#fff"/);
  assert.ok(Number(d[2]) > 52, "le chemin commence en bas du dessin");
  assert.equal((svg.match(/<path d=/g) || []).length, 3, "les deux routes du carrefour et le chemin");
  // Arrivée vers l'est (cap 90) : dessin tourné, l'arrivée reste en bas.
  const svg2 = svgCarrefour(routes, [[-1.6806, 48.1], [-1.68, 48.1], [-1.68, 48.1004]], c, 90);
  const d2 = svg2.match(/<path d="M([\d.]+) ([\d.]+)[^"]*" fill="none" stroke="#fff"/);
  assert.ok(Number(d2[2]) > 52 && Math.abs(Number(d2[1]) - 50) < 2);
});

test("feuille de route : entrées, sorties numérotées, échangeurs (pas les ronds-points)", async () => {
  const { echangeursDuTrajet } = await import("../js/panneau-nav.js");
  const e = echangeursDuTrajet([
    { maneuver: "TURN_LEFT", junctionType: "REGULAR", routeOffsetInMeters: 500 },
    { maneuver: "TAKE_EXIT", junctionType: "ROUNDABOUT", routeOffsetInMeters: 2000 },
    { maneuver: "ENTER_MOTORWAY", junctionType: "REGULAR", routeOffsetInMeters: 12340, roadNumbers: ["A81", "E50"], signpostText: "Laval" },
    { maneuver: "KEEP_LEFT", junctionType: "BIFURCATION", routeOffsetInMeters: 30000, roadNumbers: ["N157"] },
    { maneuver: "TAKE_EXIT", junctionType: "REGULAR", routeOffsetInMeters: 45000, exitNumber: "4", roadNumbers: ["D31"], signpostText: "Laval-Centre" },
  ]);
  assert.deepEqual(e.map((x) => [x.km, x.type, x.sortie]), [[12.3, "entree", ""], [30, "echangeur", ""], [45, "sortie", "4"]]);
  assert.equal(e[2].direction, "Laval-Centre");
});
