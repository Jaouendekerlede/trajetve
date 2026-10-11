import { test } from "node:test";
import assert from "node:assert/strict";
import { installerFetch } from "./aide.mjs";
import { infosOfficiellesBorne } from "../js/irve.js";

// La base officielle renvoie parfois la même ligne deux fois pour un même
// point de charge -- repéré sur une vraie station (Intermarché Saint-Nazaire,
// 3 bornes sur place, affichées comme 6). agregerStation() doit dédoublonner
// par id_pdc_itinerance avant de compter les points.
function lignePdc(idPdc) {
  return {
    id_station_itinerance: "FRPD1PITMSNZ",
    id_pdc_itinerance: idPdc,
    nom_station: "Intermarché - Saint-Nazaire",
    adresse_station: "41 rue Jacques Offenbach, Saint-Nazaire",
    nom_operateur: "Power Dot France",
    consolidated_latitude: 47.263272,
    consolidated_longitude: -2.237996,
    nbre_pdc: 3,
    puissance_nominale: 50,
    prise_type_combo_ccs: idPdc.endsWith("22"),
    prise_type_2: idPdc.endsWith("23"),
    prise_type_chademo: idPdc.endsWith("21"),
  };
}

test("agregerStation (via infosOfficiellesBorne) : des lignes dupliquées pour le même point ne gonflent pas le nombre de bornes", async () => {
  const lignes = ["FRPD1EITMSNZEFA00021", "FRPD1EITMSNZEFA00022", "FRPD1EITMSNZEFA00023"].flatMap((id) => [lignePdc(id), lignePdc(id)]);
  installerFetch(() => ({ json: { data: lignes } }));
  const o = await infosOfficiellesBorne(47.263272, -2.237996, { operateur: "Power Dot France" });
  assert.equal(o.points_consultes, 3, "3 points réels, pas 6 (doublons écartés)");
  assert.equal(o.nombre_points, 3);
  assert.equal(o.ids_pdc.length, 3);
  assert.equal(new Set(o.ids_pdc).size, 3, "pas d'id en double");
});
