// Ce qui se trouve le long du tracé : zones de danger (radars fixes) et
// feux tricolores avant les manœuvres. Module sans carte ni réseau : testé à part.
//
// Radars : la loi française (décret 2012-3) interdit d'indiquer leur
// emplacement ; seules des « zones de danger » sont permises, de longueur
// fixe (≈ 4 km sur autoroute, 2 km hors agglomération, 300 m en ville),
// sans dire ce qu'elles contiennent. On n'affiche donc que ces zones.

// Position (m depuis le départ) du point le plus proche sur le tracé, et
// distance (m) au tracé. coords [lon, lat], cum : distances cumulées (m).
export function projeterSurTrace(lat, lon, coords, cum) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  let meilleur = { d: Infinity, offset: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - lon) * kx;
    const ay = (coords[i][1] - lat) * ky;
    const dx = (coords[i + 1][0] - coords[i][0]) * kx;
    const dy = (coords[i + 1][1] - coords[i][1]) * ky;
    // Segment loin (> 2 km) : inutile de calculer plus finement.
    if (Math.abs(ax) > 2000 && Math.abs(ax + dx) > 2000 && Math.sign(ax) === Math.sign(ax + dx)) continue;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < meilleur.d) meilleur = { d, offset: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return meilleur;
}

// Longueur légale de la zone selon la limitation au niveau du radar.
export function longueurZoneDanger(limiteKmh) {
  if (limiteKmh >= 110) return 4000;
  if (limiteKmh >= 80) return 2000;
  return 300;
}

// radars : [{ lat, lon }] ; limites : limitation de chaque point du tracé.
// Renvoie les zones [{ debut, fin, limite }] (m), fusionnées si elles se
// chevauchent. Un radar à plus de 40 m du tracé est sur une autre route.
export function zonesDeDanger(radars, coords, cum, limites) {
  const zones = [];
  for (const r of radars) {
    const p = projeterSurTrace(r.lat, r.lon, coords, cum);
    if (p.d > 40) continue;
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < p.offset) i++;
    const limite = limites[i] || null;
    const l = longueurZoneDanger(limite || 50);
    zones.push({ debut: Math.max(0, p.offset - l * 0.8), fin: p.offset + l * 0.2, limite });
  }
  zones.sort((a, b) => a.debut - b.debut);
  const fusion = [];
  for (const z of zones) {
    const der = fusion[fusion.length - 1];
    if (der && z.debut <= der.fin) {
      der.fin = Math.max(der.fin, z.fin);
      der.limite = Math.min(der.limite || Infinity, z.limite || Infinity);
      if (der.limite === Infinity) der.limite = null;
    } else fusion.push({ ...z });
  }
  return fusion;
}

const ECART_MEME_CARREFOUR_M = 35;
const ORDINAUX = ["", "Au feu, ", "Au deuxième feu, ", "Au troisième feu, "];

// Positions (m depuis le départ, triées) des points à moins de `maxD` m du
// tracé : projeter une fois par itinéraire, pas une fois par manœuvre.
export function positionsSurTrace(points, coords, cum, maxD) {
  return points
    .map((f) => projeterSurTrace(f.lat, f.lon, coords, cum))
    .filter((p) => p.d <= maxD)
    .map((p) => p.offset)
    .sort((a, b) => a - b);
}

// Nombre de feux à passer jusqu'à la manœuvre (le dernier étant au
// carrefour de la manœuvre), ou null s'il n'y a pas de feu à ce carrefour.
// positions : sortie de positionsSurTrace ; depuis : manœuvre précédente.
export function compterFeux(positions, offsetManoeuvre, depuis) {
  // Plusieurs feux (un par voie d'arrivée) au même carrefour : un seul.
  const carrefours = [];
  for (const o of positions) {
    if (o <= depuis + 15 || o > offsetManoeuvre + 20) continue;
    if (!carrefours.length || o - carrefours[carrefours.length - 1] > ECART_MEME_CARREFOUR_M) carrefours.push(o);
  }
  const dernier = carrefours[carrefours.length - 1];
  if (dernier === undefined || dernier < offsetManoeuvre - ECART_MEME_CARREFOUR_M) return null;
  return carrefours.length;
}

// « Au deuxième feu, tournez à gauche… » (au-delà de 3 feux : rien).
export function messageAvecFeu(message, n) {
  if (!n || n >= ORDINAUX.length || !message) return message;
  return ORDINAUX[n] + message.charAt(0).toLowerCase() + message.slice(1);
}

// Part (0 à 1) du nouveau tracé qui s'écarte de plus de `ecartM` m de
// l'ancien, sur ses `maxM` premiers mètres : un autre chemin, ou le même
// avec un trafic mis à jour ?
export function partDifferente(coordsNouveau, coordsAncien, cumAncien, { pasM = 300, maxM = 20000, ecartM = 40 } = {}) {
  let cumul = 0;
  let prochain = 0;
  let total = 0;
  let loin = 0;
  for (let i = 1; i < coordsNouveau.length && cumul < maxM; i++) {
    const [lonA, latA] = coordsNouveau[i - 1];
    const [lon, lat] = coordsNouveau[i];
    cumul += Math.hypot((lon - lonA) * 111320 * Math.cos((lat * Math.PI) / 180), (lat - latA) * 110540);
    if (cumul < prochain) continue;
    prochain = cumul + pasM;
    total++;
    if (projeterSurTrace(lat, lon, coordsAncien, cumAncien).d > ecartM) loin++;
  }
  return total ? loin / total : 0;
}
