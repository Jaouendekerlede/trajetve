import { test } from "node:test";
import assert from "node:assert/strict";
import { installerLocalStorage, installerFetch } from "./aide.mjs";

installerLocalStorage();
const { construireProfilEnergie } = await import("../js/energie.js");
const { obtenirProfilVehicule } = await import("../js/storage.js");

// 130 km d'autoroute tout droit, parcourus en une heure (130 km/h de moyenne).
function autoroute() {
  const coords = Array.from({ length: 261 }, (_, i) => [-1.7 + i * 0.00678, 48.1]);
  return { coords, distance_km: 130, duree_min: 60, _sections: [{ sectionType: "MOTORWAY", startPointIndex: 0, endPointIndex: 260 }], _summary: { lengthInMeters: 130000, travelTimeInSeconds: 3600, noTrafficTravelTimeInSeconds: 3600 }, depart_ms: Date.UTC(2026, 9, 4, 10) };
}

test("vitesse plafonnée à 110 km/h : moins d'énergie, plus de temps de route", async () => {
  // Relief et météo indisponibles (pas de réseau) : le calcul doit rester possible.
  installerFetch(() => {
    throw new Error("hors ligne");
  });
  const profil = obtenirProfilVehicule();
  const libre = await construireProfilEnergie(autoroute(), profil, { depart_ms: autoroute().depart_ms, patience_ms: 0 });
  const bride = await construireProfilEnergie(autoroute(), profil, { depart_ms: autoroute().depart_ms, patience_ms: 0, vitesse_max_kmh: 110 });
  assert.equal(libre.secondes_en_plus, 0, "sans plafond, aucun temps ajouté");
  // 130 km à 110 km/h : 70,9 min au lieu de 60.
  assert.ok(Math.abs(bride.secondes_en_plus / 60 - 10.9) < 0.5, `temps en plus : ${bride.secondes_en_plus / 60} min`);
  assert.ok(bride.stats.energie_totale_kwh < libre.stats.energie_totale_kwh * 0.9, `${bride.stats.energie_totale_kwh} kWh contre ${libre.stats.energie_totale_kwh}`);
  assert.ok(bride.segments.every((s) => s.vitesse <= 110.5), "aucun tronçon au-dessus du plafond");
});
