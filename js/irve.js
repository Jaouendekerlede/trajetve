// Informations officielles des bornes en France : Base nationale des IRVE
// (data.gouv.fr, mise à jour quotidienne, déclarations obligatoires des
// opérateurs). Seule source gratuite qui dit explicitement si la carte
// bancaire est acceptée. Interrogée via l'API tabulaire de data.gouv.fr
// (sans clé, CORS ouvert).

import { haversineKm } from "./geo.js";
import { extrairePrixKwh } from "./ocm.js";

const API = "https://tabular-api.data.gouv.fr/api/resources/eb76d20a-8501-400e-b336-d85724de5435/data/";
const RAYON_RECHERCHE_M = 150;
const cache = new Map();

const vrai = (v) => v === true || v === 1 || v === "true" || v === "True" || v === "1";

function texteUtile(v) {
  const t = String(v ?? "").trim();
  return t && !/^(inconnu|aucun|non renseign[ée]|n\/a|null)$/i.test(t) ? t : "";
}

function uniques(valeurs) {
  return [...new Set(valeurs.map(texteUtile).filter(Boolean))];
}

// "tout" / "partiel" / "non" pour un critère déclaré point de charge par point de charge
function synthese(lignes, champ) {
  const nb = lignes.filter((l) => vrai(l[champ])).length;
  return nb === 0 ? "non" : nb === lignes.length ? "oui" : "partiel";
}

function telephone(t) {
  const brut = texteUtile(t).replace(/^tel:/i, "");
  return brut ? { affichage: brut.replace(/[-.]/g, " "), lien: `tel:${brut.replace(/[^\d+]/g, "")}` } : null;
}

function agregerStation(lignes, distanceM) {
  const l0 = lignes[0];
  const prises = {};
  const ajouterPrise = (cle, libelle, ligne) => {
    const p = (prises[cle] ??= { libelle, nombre: 0, puissance_max_kw: 0 });
    p.nombre++;
    p.puissance_max_kw = Math.max(p.puissance_max_kw, Number(ligne.puissance_nominale) || 0);
  };
  for (const l of lignes) {
    if (vrai(l.prise_type_combo_ccs)) ajouterPrise("ccs", "Combo CCS (charge rapide)", l);
    if (vrai(l.prise_type_2)) ajouterPrise("type2", "Type 2", l);
    if (vrai(l.prise_type_chademo)) ajouterPrise("chademo", "CHAdeMO", l);
    if (vrai(l.prise_type_ef)) ajouterPrise("ef", "Prise domestique E/F", l);
    if (vrai(l.prise_type_autre)) ajouterPrise("autre", "Autre prise", l);
  }
  const dates = (champ) => lignes.map((l) => texteUtile(l[champ])).filter(Boolean).sort();

  return {
    id_station: l0.id_station_itinerance,
    nom_station: texteUtile(l0.nom_station),
    adresse: texteUtile(l0.adresse_station),
    implantation: texteUtile(l0.implantation_station),
    operateur: texteUtile(l0.nom_operateur),
    enseigne: texteUtile(l0.nom_enseigne),
    amenageur: texteUtile(l0.nom_amenageur),
    contact: texteUtile(l0.contact_operateur),
    telephone: telephone(l0.telephone_operateur),
    nombre_points: Math.max(lignes.length, Number(l0.nbre_pdc) || 0),
    points_consultes: lignes.length,
    puissance_max_kw: Math.max(0, ...lignes.map((l) => Number(l.puissance_nominale) || 0)),
    prises: Object.values(prises),
    paiement_cb: synthese(lignes, "paiement_cb"),
    paiement_acte: synthese(lignes, "paiement_acte"),
    paiement_autre: synthese(lignes, "paiement_autre"),
    gratuit: synthese(lignes, "gratuit"),
    tarifs: uniques(lignes.map((l) => l.tarification)),
    condition_acces: uniques(lignes.map((l) => l.condition_acces)).join(" / "),
    horaires: uniques(lignes.map((l) => l.horaires)).join(" / "),
    reservation: synthese(lignes, "reservation"),
    accessibilite_pmr: uniques(lignes.map((l) => l.accessibilite_pmr)).join(" / "),
    restriction_gabarit: uniques(lignes.map((l) => l.restriction_gabarit)).join(" / "),
    cable_attache: synthese(lignes, "cable_t2_attache"),
    deux_roues: synthese(lignes, "station_deux_roues"),
    observations: uniques(lignes.map((l) => l.observations)).join(" / "),
    date_mise_en_service: dates("date_mise_en_service")[0] || "",
    date_maj: dates("date_maj").pop() || "",
    distance_m: Math.round(distanceM),
  };
}

function ressemblance(a, b) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = n(a);
  const y = n(b);
  return x && y && (x.includes(y) || y.includes(x)) ? 1 : 0;
}

// Renvoie la station officielle la plus proche (≤ 150 m) de la borne Open
// Charge Map donnée, ou null si aucune (borne hors France, ou non déclarée).
export async function infosOfficiellesBorne(lat, lon, indices = {}) {
  if (lat == null || lon == null) return null;
  const cle = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  if (cache.has(cle)) return cache.get(cle);

  const promesse = (async () => {
    const dLat = RAYON_RECHERCHE_M / 111000;
    const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const params = new URLSearchParams({
      consolidated_latitude__greater: (lat - dLat).toFixed(6),
      consolidated_latitude__less: (lat + dLat).toFixed(6),
      consolidated_longitude__greater: (lon - dLon).toFixed(6),
      consolidated_longitude__less: (lon + dLon).toFixed(6),
      page_size: "50",
    });
    try {
      const resp = await fetch(`${API}?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const lignes = (await resp.json()).data || [];
      const stations = new Map();
      for (const l of lignes) {
        const id = l.id_station_itinerance || `${l.consolidated_latitude},${l.consolidated_longitude}`;
        if (!stations.has(id)) stations.set(id, []);
        stations.get(id).push(l);
      }
      let meilleure = null;
      for (const groupe of stations.values()) {
        const l0 = groupe[0];
        const distanceM = haversineKm(lat, lon, Number(l0.consolidated_latitude), Number(l0.consolidated_longitude)) * 1000;
        if (!(distanceM <= RAYON_RECHERCHE_M)) continue;
        // à distance comparable, préférer le même opérateur/enseigne
        const note = distanceM - 60 * (ressemblance(indices.operateur, l0.nom_operateur) || ressemblance(indices.operateur, l0.nom_enseigne));
        if (!meilleure || note < meilleure.note) meilleure = { note, groupe, distanceM };
      }
      return meilleure ? agregerStation(meilleure.groupe, meilleure.distanceM) : null;
    } catch (e) {
      console.warn("[IRVE] Infos officielles indisponibles", e);
      cache.delete(cle); // réessayer la prochaine fois
      return { indisponible: true };
    }
  })();
  cache.set(cle, promesse);
  return promesse;
}

// Ajoute `officiel` à chaque borne ; si Open Charge Map n'avait pas de
// tarif, reprend le tarif officiel déclaré (quand il est en €/kWh).
export async function enrichirBornes(bornes) {
  await Promise.all(
    bornes.map(async (b) => {
      if (b.officiel === undefined) b.officiel = await infosOfficiellesBorne(b.lat, b.lon, { operateur: b.operateur });
      if (b.prix_est_estimation && b.officiel?.tarifs?.length) {
        for (const tarif of b.officiel.tarifs) {
          const centimes = /(\d+(?:[.,]\d+)?)\s*(?:cts?|centimes?|c€)\s*\/?\s*kwh/i.exec(tarif);
          const prix = centimes ? parseFloat(centimes[1].replace(",", ".")) / 100 : extrairePrixKwh(tarif);
          if (prix !== null && prix > 0 && prix < 2) {
            b.prix_kwh_eur = prix;
            b.prix_est_estimation = false;
            b.prix_source = "officiel";
            break;
          }
        }
      }
    }),
  );
  return bornes;
}
