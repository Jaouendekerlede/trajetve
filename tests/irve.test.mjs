import { test } from "node:test";
import assert from "node:assert/strict";
import { installerFetch, installerLocalStorage } from "./aide.mjs";
import { infosOfficiellesBorne, enrichirBornes } from "../js/irve.js";
import { operateurPeuFiable, fiabiliteOperateur } from "../js/storage.js";

installerLocalStorage();

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

test("fiabilité des opérateurs : un opérateur qui ne transmet jamais est repéré après plusieurs bornes, pas après une seule", async () => {
  const lignes = [{
    id_station_itinerance: "FRMUETSTATION",
    id_pdc_itinerance: "FRMUET00001",
    nom_station: "Borne muette",
    adresse_station: "1 rue du Silence",
    nom_operateur: "Operateur Muet",
    consolidated_latitude: 48.1,
    consolidated_longitude: -1.6,
    nbre_pdc: 1,
    puissance_nominale: 22,
    prise_type_2: true,
  }];
  installerFetch((url) => (url.includes("tabular-api.data.gouv.fr") ? { json: { data: lignes } } : { texte: "id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage\n" }));
  for (let i = 0; i < 4; i++) {
    const borne = { lat: 48.1, lon: -1.6, operateur: "Operateur Muet" };
    await enrichirBornes([borne], { attendreEtats: true });
  }
  assert.equal(operateurPeuFiable("Operateur Muet"), false, "pas encore assez d'observations (4 < 5)");
  const borne5 = { lat: 48.1, lon: -1.6, operateur: "Operateur Muet" };
  await enrichirBornes([borne5], { attendreEtats: true });
  assert.equal(fiabiliteOperateur("Operateur Muet").aucune, 5);
  assert.equal(operateurPeuFiable("Operateur Muet"), true, "5 observations, jamais rien -- repéré");
});
