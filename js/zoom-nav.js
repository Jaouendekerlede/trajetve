// Zoom de la carte pendant la navigation, comme un GPS : large sur
// autoroute, rapproché en ville, et encore plus près là où il faut bien
// voir : ronds-points, grands carrefours, sorties d'autoroute (voie de
// décélération puis bretelle) et entrées (bretelle puis voie d'accélération).
// Module sans carte ni écran : testé à part.

// Zoom selon la vitesse. Les seuils ont 5 km/h d'hystérésis pour que la
// carte ne « pompe » pas autour de 50 km/h.
export const PALIERS_ZOOM = [
  { min: 90, zoom: 15 },
  { min: 50, zoom: 16 },
  { min: 30, zoom: 17 },
  { min: -1, zoom: 18 },
];

// Par type de manœuvre : zoom, début avant (secondes de trajet, bornées en
// mètres) et maintien après le point de la manœuvre (m).
export const REGLES_ZOOM = {
  // Tout le tour du rond-point reste zoomé (la manœuvre est à l'entrée).
  rondpoint: { zoom: 19, secondes: 14, avantMin: 200, avantMax: 450, apres: 160 },
  carrefour: { zoom: 18.5, secondes: 12, avantMin: 150, avantMax: 400, apres: 60 },
  // Voie de décélération (jusqu'à ~900 m avant à 130 km/h), puis bretelle.
  sortie: { zoom: 17, secondes: 25, avantMin: 400, avantMax: 900, apres: 500 },
  // Bretelle, puis voie d'accélération jusqu'à l'insertion.
  entree: { zoom: 17, secondes: 12, avantMin: 200, avantMax: 400, apres: 700 },
  simple: { zoom: 18, secondes: 12, avantMin: 150, avantMax: 350, apres: 30 },
};
const ZOOM_MAX = 19;

const SORTIES = /TAKE_EXIT|MOTORWAY_EXIT/;
// Voie rapide (voie express, rocade, autoroute) et écart de limitation qui
// signale une bretelle quand TomTom ne le dit pas (« prenez la sortie sur
// N136 » au sortir d'un rond-point, par exemple).
const VITESSE_RAPIDE = 90;
const ECART_BRETELLE = 20;
const ENTREES = /ENTER_(MOTORWAY|FREEWAY|HIGHWAY)|ENTRANCE_RAMP/;
const DELICATES = /U_?TURN|SHARP_/;
const ENCHAINEMENT_M = 200;
const VOIES_GRAND_CARREFOUR = 3;

// Limitations autour d'une manœuvre : juste avant (100 m), et la plus
// haute entre 200 et 700 m après (la bretelle mène à la voie rapide).
// limites : limitation (km/h ou null) de chaque point ; cum : distances (m).
export function vitessesAutour(offset, cum, limites) {
  const indice = (d) => {
    let bas = 0;
    let haut = cum.length - 1;
    while (bas < haut) {
      const milieu = (bas + haut + 1) >> 1;
      if (cum[milieu] <= d) bas = milieu;
      else haut = milieu - 1;
    }
    return bas;
  };
  const avant = limites[indice(Math.max(0, offset - 100))] || null;
  let apres = null;
  for (let i = indice(offset + 200); i < cum.length && cum[i] <= offset + 700; i++) if (limites[i] && limites[i] > (apres || 0)) apres = limites[i];
  return { avant, apres };
}

export function estEntreeVoieRapide(instr) {
  return !!(instr.vitesseApres >= VITESSE_RAPIDE && instr.vitesseAvant && instr.vitesseAvant <= instr.vitesseApres - ECART_BRETELLE);
}

function estSortieVoieRapide(instr) {
  return !!(instr.vitesseAvant >= VITESSE_RAPIDE && instr.vitesseApres && instr.vitesseApres <= instr.vitesseAvant - ECART_BRETELLE);
}

// instr : { offset, manoeuvre, jonction, vitesseAvant, vitesseApres } ;
// voies : sections « lanes » ({ offset, lanes }) ; suivante : instruction
// d'après (ou null).
export function typeManoeuvre(instr, voies = [], suivante = null) {
  const m = instr.manoeuvre || "";
  if (/ROUNDABOUT/.test(m) || instr.jonction === "ROUNDABOUT") return "rondpoint";
  if (SORTIES.test(m) || estSortieVoieRapide(instr)) return "sortie";
  if (ENTREES.test(m) || estEntreeVoieRapide(instr)) return "entree";
  // Bifurcation sur voie rapide (« tenez la droite vers A84 ») : comme une
  // sortie ; en ville, c'est un carrefour.
  if (instr.jonction === "BIFURCATION" && /KEEP_|BEAR_/.test(m)) return (instr.vitesseAvant || 0) >= VITESSE_RAPIDE ? "sortie" : "carrefour";
  const section = voies.find((v) => Math.abs(v.offset - instr.offset) < 40);
  if (section && section.lanes.length >= VOIES_GRAND_CARREFOUR) return "carrefour";
  if (DELICATES.test(m)) return "carrefour";
  if (suivante && suivante.offset - instr.offset < ENCHAINEMENT_M) return "carrefour";
  return "simple";
}

// Zoom voulu autour d'une manœuvre à `distance` m devant (négative : déjà
// passée), ou null si elle est trop loin.
export function zoomManoeuvre(type, distance, kmh) {
  const r = REGLES_ZOOM[type];
  const avant = Math.min(r.avantMax, Math.max(r.avantMin, (kmh / 3.6) * r.secondes));
  if (distance > avant || distance < -r.apres) return null;
  // Sur une bretelle, on se rapproche encore quand on ralentit.
  const bonus = type === "sortie" || type === "entree" ? (kmh < 50 ? 1 : kmh < 80 ? 0.5 : 0) : 0;
  return Math.min(ZOOM_MAX, r.zoom + bonus);
}

function zoomVitesse(kmh, zoomActuel, sortieDeManoeuvre) {
  const cible = PALIERS_ZOOM.find((p) => kmh > p.min).zoom;
  if (!Number.isFinite(zoomActuel) || sortieDeManoeuvre || !PALIERS_ZOOM.some((p) => p.zoom === zoomActuel) || Math.abs(cible - zoomActuel) > 1) return cible;
  // Palier voisin : on ne change que si la vitesse a franchi le seuil de 5 km/h.
  const seuil = PALIERS_ZOOM.find((p) => p.zoom === Math.min(cible, zoomActuel)).min;
  return Math.abs(kmh - seuil) >= 5 ? cible : zoomActuel;
}

// instructions triées par offset ({ offset, manoeuvre, type, jonction }).
// Renvoie { zoom, manoeuvre } : manoeuvre = type qui impose le zoom, ou null.
// renforce = false : même zoom modéré pour toutes les manœuvres (réglage).
export function zoomNavigation({ kmh, offset, instructions, voies = [], zoomActuel, enManoeuvre = false, renforce = true }) {
  let meilleur = null;
  let type = null;
  const utiles = instructions.filter((i) => i.type !== "LOCATION_DEPARTURE" && !/WAYPOINT|ARRIVE/.test(i.manoeuvre || ""));
  for (let k = 0; k < utiles.length; k++) {
    const instr = utiles[k];
    const distance = instr.offset - offset;
    if (distance < -REGLES_ZOOM.entree.apres) continue;
    if (distance > REGLES_ZOOM.sortie.avantMax) break;
    const types = [renforce ? typeManoeuvre(instr, voies, utiles[k + 1] || null) : "simple"];
    // Rond-point dont la sortie est une bretelle : puis voie d'accélération.
    if (renforce && types[0] === "rondpoint" && estEntreeVoieRapide(instr)) types.push("entree");
    for (const t of types) {
      const z = zoomManoeuvre(t, distance, kmh);
      if (z !== null && (meilleur === null || z > meilleur)) {
        meilleur = z;
        type = t;
      }
    }
  }
  if (meilleur !== null) return { zoom: meilleur, manoeuvre: type };
  return { zoom: zoomVitesse(kmh, zoomActuel, enManoeuvre), manoeuvre: null };
}
