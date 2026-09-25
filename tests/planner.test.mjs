import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage, installerFetch, poiOcm } from "./aide.mjs";
import { calculerTempsCharge, calculerTrajetElectrique, formaterMinutes } from "../js/planner.js";
import { PROFIL_PAR_DEFAUT, MULTIPLICATEURS_SAISON } from "../js/config.js";
import { viderMemoire } from "../js/util.js";

installerLocalStorage();
// Chaque test a ses propres fausses bornes : pas de réponse gardée en mémoire.
beforeEach(viderMemoire);

// Trajet fictif en ligne droite vers le nord : 4° de latitude ≈ 445 km.
const TRACE = Array.from({ length: 41 }, (_, i) => [0, i / 10]);
const DISTANCE_KM = 444.8;
const PROFIL = { ...PROFIL_PAR_DEFAUT, saison: "mi_saison" };

// Fausse API Open Charge Map : une borne juste à côté du point demandé,
// (ou plusieurs, via fabrique(lat, lon)).
function bornesAutour(fabrique) {
  return installerFetch((url) => {
    const p = new URL(url).searchParams;
    return { json: fabrique(Number(p.get("latitude")), Number(p.get("longitude"))) };
  });
}

test("temps de charge : Kona 64 kWh (77 kW) de 10 à 80 % ≈ 47 min, comme annoncé par Hyundai", () => {
  const profil = { ...PROFIL, puissance_dc_kw: 77 };
  const minutes = calculerTempsCharge(0.7 * profil.capacite_kwh, 100, { pctDebut: 10, profil });
  assert.ok(Math.abs(minutes - 47) <= 3, `obtenu ${minutes.toFixed(1)} min`);
});

test("temps de charge : sur borne lente, la voiture est limitée par son chargeur (11 kW)", () => {
  const minutes = calculerTempsCharge(22, 22, { pctDebut: 20, profil: PROFIL });
  assert.ok(Math.abs(minutes - (22 / 11) * 60 * 1.08) < 0.5, `obtenu ${minutes.toFixed(1)} min`);
});

test("temps de charge : la charge ralentit en fin de batterie", () => {
  const debut = calculerTempsCharge(6.48, 150, { pctDebut: 20, profil: PROFIL });
  const fin = calculerTempsCharge(6.48, 150, { pctDebut: 85, profil: PROFIL });
  assert.ok(fin > debut * 2, `20→30 % : ${debut.toFixed(1)} min, 85→95 % : ${fin.toFixed(1)} min`);
});

test("trajet direct : aucune recharge si la batterie suffit", async () => {
  bornesAutour(() => []);
  const r = await calculerTrajetElectrique("cle", 200, TRACE, 80, PROFIL, { margeSecuritePct: 12, cibleRechargePct: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.nb_arrets, 0);
  assert.ok(r.pct_batterie_arrivee > 30);
});

test("trajet long : un arrêt au bon endroit, dernière recharge seulement au nécessaire", async () => {
  bornesAutour((lat, lon) => [poiOcm({ nom: "Aire rapide", lat: lat + 0.002, lon, kw: 150 })]);
  const r = await calculerTrajetElectrique("cle", DISTANCE_KM, TRACE, 80, PROFIL, { margeSecuritePct: 12, cibleRechargePct: 80 });
  assert.equal(r.ok, true, r.erreur);
  assert.equal(r.nb_arrets, 1);
  const a = r.arrets[0];
  // 80 % − 12 % de marge = 44 kWh, à la consommation du profil corrigée
  // par la saison.
  const conso = PROFIL.consommation_kwh_100km * (MULTIPLICATEURS_SAISON[PROFIL.saison] ?? 1);
  const kmAttendu = ((0.68 * PROFIL.capacite_kwh) / conso) * 100;
  assert.ok(Math.abs(a.km_depuis_depart - kmAttendu) < 3, `arrêt au km ${a.km_depuis_depart}, attendu ~${kmAttendu.toFixed(0)}`);
  assert.ok(a.pct_depart_borne < 80, `recharge partielle attendue, obtenu ${a.pct_depart_borne} %`);
  assert.ok(Math.abs(r.pct_batterie_arrivee - 17) <= 1.5, `arrivée à ${r.pct_batterie_arrivee} % (marge 12 + réserve 5)`);
  assert.ok(a.temps_charge_min > 3 && a.temps_charge_min < 30, `${a.temps_charge_min} min`);
});

test("station entièrement hors service : écartée au profit d'une autre", async () => {
  bornesAutour((lat, lon) => [poiOcm({ nom: "Station en panne", lat: lat + 0.001, lon, kw: 350 }), poiOcm({ nom: "Station qui marche", lat: lat + 0.004, lon, kw: 150 })]);
  const r = await calculerTrajetElectrique("cle", DISTANCE_KM, TRACE, 80, PROFIL, {
    margeSecuritePct: 12,
    cibleRechargePct: 80,
    enrichirBornes: async (candidates) => {
      for (const b of candidates) if (b.nom === "Station en panne") b.etat_dynamique = { total: 4, hors_service: 4, tous_hors_service: true, libres: 0, occupes: 0 };
    },
  });
  assert.equal(r.ok, true, r.erreur);
  assert.equal(r.arrets[0].nom_borne, "Station qui marche");
});

test("borne lente seule disponible : temps de charge réaliste (chargeur embarqué)", async () => {
  bornesAutour((lat, lon) => [poiOcm({ nom: "Parking", lat: lat + 0.001, lon, kw: 22 })]);
  const r = await calculerTrajetElectrique("cle", DISTANCE_KM, TRACE, 80, PROFIL, { margeSecuritePct: 12, cibleRechargePct: 80 });
  assert.equal(r.ok, true, r.erreur);
  const a = r.arrets[0];
  assert.equal(a.puissance_kw, 11, "puissance reçue = chargeur embarqué");
  const attendu = (a.kwh_ajoutes / 11) * 60 * 1.08;
  assert.ok(Math.abs(a.temps_charge_min - attendu) <= 1, `${a.temps_charge_min} min, attendu ${attendu.toFixed(0)}`);
});

test("aucune borne compatible : message clair", async () => {
  bornesAutour(() => []);
  const r = await calculerTrajetElectrique("cle", DISTANCE_KM, TRACE, 80, PROFIL, { margeSecuritePct: 12, cibleRechargePct: 80 });
  assert.equal(r.ok, false);
  assert.match(r.erreur, /Aucune borne/);
});

test("formatage des durées", () => {
  assert.equal(formaterMinutes(45), "45 min");
  assert.equal(formaterMinutes(125), "2 h 05");
});
