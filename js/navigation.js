// Navigation GPS : suivi de la voiture sur l'itinéraire (via les bornes de
// recharge prévues), guidage vocal tourne-à-tourne (instructions TomTom en
// français), recalcul automatique hors itinéraire, mise à jour du trafic,
// vitesse et limitation, heure d'arrivée, batterie estimée en direct.
// Fonctionne tant que l'appli est ouverte à l'écran (limite des applis web).

import { getApiKeys } from "./config.js";
import { obtenirProfilVehicule, lireReglages, sauverReglages, ajouterAuJournal, enregistrerMesureConso } from "./storage.js";
import { calculerItineraireTomTom } from "./tomtom.js";
import { guidageHorsLigne } from "./hors-ligne.js";
import { haversineKm } from "./geo.js";
import { formaterMinutes } from "./planner.js";
import { escapeHtml } from "./util.js";
import { rechercherBornesZone } from "./ocm.js";
import { stationsOfficiellesZone, fusionnerBornes } from "./irve.js";
import * as carte2D from "./carte.js";
import * as carte3D from "./carte3d.js";

// Carte utilisée pendant la navigation : 3D si possible, sinon 2D. Les deux
// modules offrent les mêmes fonctions.
let vue = carte2D;

const $ = (id) => document.getElementById(id);
const DELAI_TRAFIC_MS = 5 * 60 * 1000;
const DELAI_MIN_RECALCUL_MS = 20 * 1000;
// 2× la vitesse réelle : assez rapide pour la démo sans réclamer trop de
// cartes par seconde aux serveurs (TomTom limite le débit).
const ACCELERATION_DEMO = 2;
const DELAI_BORNES_MS = 90 * 1000;
const RAYON_BORNES_KM = 12;
const DISTANCE_MIN_RAFRAICHIR_BORNES_KM = RAYON_BORNES_KM * 0.4;

let etat = null;

// ── Utilitaires ─────────────────────────────────────────────────────────────

function heure(ms) {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function distanceAffichee(m) {
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

function distanceParlee(m) {
  if (m >= 1000) {
    const km = Math.round(m / 100) / 10;
    return `${String(km).replace(".", ",")} kilomètre${km >= 2 ? "s" : ""}`;
  }
  return `${m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10} mètres`;
}

function minusculeInitiale(texte) {
  return texte ? texte.charAt(0).toLowerCase() + texte.slice(1) : "";
}

function capEntre(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const FLECHES = [
  [/ARRIVE/, "🏁"],
  [/WAYPOINT/, "🔋"],
  [/U_?TURN/, "↩️"],
  [/ROUNDABOUT/, "🔄"],
  [/FERRY/, "⛴️"],
  [/SHARP_RIGHT|TURN_RIGHT/, "➡️"],
  [/SHARP_LEFT|TURN_LEFT/, "⬅️"],
  [/BEAR_RIGHT|KEEP_RIGHT|EXIT_RIGHT|TAKE_EXIT/, "↗️"],
  [/BEAR_LEFT|KEEP_LEFT|EXIT_LEFT/, "↖️"],
];

function fleche(manoeuvre) {
  for (const [motif, icone] of FLECHES) if (motif.test(manoeuvre || "")) return icone;
  return "⬆️";
}

function parler(texte, prioritaire = false) {
  if (!etat?.voix || !texte || !("speechSynthesis" in window)) return;
  if (prioritaire) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texte);
  u.lang = "fr-FR";
  speechSynthesis.speak(u);
}

// ── Itinéraire de navigation ───────────────────────────────────────────────

function construireRoute(r) {
  const coords = r.coords;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]) * 1000);
  const dernier = cum.length - 1;

  const instructions = (r.guidance?.instructions || [])
    .filter((i) => i.message || i.maneuver)
    .map((i) => ({
      offset: cum[Math.min(Math.max(0, i.pointIndex ?? 0), dernier)],
      message: i.message || "",
      manoeuvre: i.maneuver || "",
      type: i.instructionType || "",
      annonces: new Set(),
    }))
    .sort((a, b) => a.offset - b.offset);

  const limites = new Array(coords.length).fill(null);
  for (const s of r.sections || []) {
    const type = String(s.sectionType || "").toUpperCase().replace(/_/g, "");
    if (type !== "SPEEDLIMIT" || !s.maxSpeedLimitInKmh) continue;
    for (let i = Math.max(0, s.startPointIndex ?? 0); i <= Math.min(dernier, s.endPointIndex ?? 0); i++) limites[i] = s.maxSpeedLimitInKmh;
  }

  // Étapes (bornes) = fins des tronçons TomTom ; durées par tronçon pour l'heure d'arrivée.
  const troncons = [];
  let indice = 0;
  for (const leg of r.legs || []) {
    const debutIdx = indice;
    indice += leg.nbPoints;
    const finIdx = Math.min(indice - 1, dernier);
    troncons.push({ debut: cum[debutIdx] ?? 0, fin: cum[finIdx], duree: leg.summary?.travelTimeInSeconds || 0 });
  }
  if (!troncons.length) troncons.push({ debut: 0, fin: cum[dernier], duree: r.summary?.travelTimeInSeconds || 0 });

  // Voies de circulation : la section se termine sur la manœuvre concernée,
  // et `follow` marque la ou les voies à prendre.
  const voies = (r.sections || [])
    .filter((s) => s.sectionType === "LANES" && s.lanes?.length > 1 && s.lanes.some((l) => l.follow))
    .map((s) => ({ offset: cum[Math.min(Math.max(0, s.endPointIndex ?? 0), dernier)], lanes: s.lanes }))
    .sort((a, b) => a.offset - b.offset);

  return { coords, cum, total: cum[dernier], instructions, limites, troncons, voies };
}

// Partie du tracé choisi encore devant la voiture. La recherche repart du
// dernier point atteint pour ne pas s'accrocher à un passage antérieur
// (route qui repasse près d'elle-même).
export function traceRestante(coords, lat, lon, depuis = 0) {
  let meilleur = depuis;
  let dMin = Infinity;
  for (let i = depuis; i < coords.length; i++) {
    const d = haversineKm(lat, lon, coords[i][1], coords[i][0]);
    if (d < dMin) {
      dMin = d;
      meilleur = i;
    }
  }
  return { indice: meilleur, coords: coords.slice(meilleur) };
}

async function calculerRouteNav(pos, cap) {
  const cle = getApiKeys().tomtom;
  const o = etat.options || {};
  let traceImposee = null;
  // TomTom refuse tracé imposé + étapes : tant qu'il reste des bornes (qui
  // sont sur la route choisie), le guidage passe simplement par elles.
  if (etat.plan.suivre_trace && !etat.arretsRestants.length && etat.plan.coords?.length) {
    const reste = traceRestante(etat.plan.coords, pos.lat, pos.lon, etat.indiceTrace);
    etat.indiceTrace = reste.indice;
    if (reste.coords.length >= 2) traceImposee = [[pos.lon, pos.lat], ...reste.coords];
  }
  const r = await calculerItineraireTomTom(cle, pos.lat, pos.lon, etat.destination.lat, etat.destination.lon, {
    etapes: etat.arretsRestants.map((a) => ({ lat: a.lat, lon: a.lon })),
    traceImposee,
    instructions: true,
    cap,
    eviterPeages: o.eviter_peages,
    eviterFerries: o.eviter_ferries,
    eviterZonesFaiblesEmissions: o.eviter_zones_faibles_emissions,
    eviterRoutesNonRevetues: o.eviter_routes_non_revetues,
  });
  if (!r.erreur) return construireRoute(r);
  // Pas de réseau : guidage préparé à l'avance (« 📥 Hors ligne »), s'il
  // correspond à ce trajet et aux bornes restantes.
  const garde = guidageHorsLigne(etat.destination.lat, etat.destination.lon, etat.arretsRestants.length);
  return garde ? construireRoute(garde) : null;
}

function installerRoute(route) {
  etat.route = route;
  etat.idx = 0;
  etat.offset = 0;
  // Les distances de l'animation se rapportaient à l'ancien tracé.
  if (etat.aff) etat.aff.offset = null;
  etat.anim = null;
  etat.annoncesBornes = new Set();
  vue.dessinerRouteNavigation(route.coords, etat.arretsRestants, etat.destination);
  if (etat.pos) {
    const m = projeter(etat.pos.lat, etat.pos.lon, null);
    etat.idx = m.i;
    etat.offset = m.offset;
  }
}

// Projette la position sur l'itinéraire (recherche autour du dernier point connu).
function projeter(lat, lon, depuis) {
  const { coords, cum } = etat.route;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  const chercher = (debut, fin) => {
    let meilleur = { d: Infinity, i: 0, offset: 0, lat, lon };
    for (let i = debut; i < fin; i++) {
      const [lonA, latA] = coords[i];
      const [lonB, latB] = coords[i + 1];
      const ax = (lonA - lon) * kx;
      const ay = (latA - lat) * ky;
      const dx = (lonB - lonA) * kx;
      const dy = (latB - latA) * ky;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < meilleur.d) meilleur = { d, i, offset: cum[i] + t * (cum[i + 1] - cum[i]), lat: latA + t * (latB - latA), lon: lonA + t * (lonB - lonA) };
    }
    return meilleur;
  };
  const n = coords.length - 1;
  if (depuis === null || depuis === undefined) return chercher(0, n);
  const local = chercher(Math.max(0, depuis - 40), Math.min(n, depuis + 500));
  return local.d > 150 ? chercher(0, n) : local;
}

// ── Temps, batterie ─────────────────────────────────────────────────────────

function secondesRestantesJusqua(offsetCible) {
  let s = 0;
  for (const t of etat.route.troncons) {
    if (t.fin <= etat.offset || t.debut >= offsetCible) continue;
    const longueur = Math.max(1, t.fin - t.debut);
    const debut = Math.max(t.debut, etat.offset);
    const fin = Math.min(t.fin, offsetCible);
    s += (t.duree * (fin - debut)) / longueur;
  }
  return s;
}

// La voiture indique pctReel : consommation réelle depuis le dernier repère
// de batterie (départ, borne ou correction précédente).
function mesurerConso(pctReel) {
  const km = (etat.odometre - etat.batterie.refOdometre) / 1000;
  const kwh = ((etat.batterie.refPct - pctReel) / 100) * etat.capacite;
  if (kwh > 0) enregistrerMesureConso(km, kwh);
}

function batterieEstimee() {
  const b = etat.batterie;
  return b.refPct - ((etat.odometre - b.refOdometre) / 1000) * (etat.consoKwhKm / etat.capacite) * 100;
}

// ── Écran ───────────────────────────────────────────────────────────────────

const FLECHES_VOIE = {
  STRAIGHT: "↑",
  LEFT: "←",
  RIGHT: "→",
  SLIGHT_LEFT: "↖",
  SLIGHT_RIGHT: "↗",
  SHARP_LEFT: "↙",
  SHARP_RIGHT: "↘",
  LEFT_U_TURN: "↶",
  RIGHT_U_TURN: "↷",
};
// Au-delà, trop tôt pour être utile ; sur autoroute, 800 m laissent le
// temps de changer de file.
const DISTANCE_MAX_VOIES_M = 800;

// Bandeau des voies (comme Sygic) : chaque voie avec ses flèches, celle(s)
// à prendre en évidence. Seulement pour la prochaine manœuvre, quand
// TomTom connaît les voies à cet endroit.
function afficherVoies(instr) {
  const zone = $("ev-nav-voies");
  const reste = instr ? instr.offset - etat.offset : Infinity;
  const section = instr && !etat.aLaBorne && !etat.arrive && reste < DISTANCE_MAX_VOIES_M ? etat.route.voies.find((v) => Math.abs(v.offset - instr.offset) < 40) : null;
  if (!section) {
    zone.classList.add("hidden");
    zone.dataset.cle = "";
    return;
  }
  const cle = String(section.offset);
  if (zone.dataset.cle === cle) return;
  zone.dataset.cle = cle;
  zone.innerHTML = section.lanes
    .map((l) => {
      const fleches = (l.directions || ["STRAIGHT"]).map((d) => `<span class="${d === l.follow ? "suivre" : ""}">${FLECHES_VOIE[d] || "↑"}</span>`).join("");
      return `<div class="ev-nav-voie${l.follow ? " active" : ""}">${fleches}</div>`;
    })
    .join("");
  zone.classList.remove("hidden");
}

function afficherAlerte(texte, bouton) {
  const el = $("ev-nav-alerte");
  if (!texte) {
    el.classList.add("hidden");
    return;
  }
  el.innerHTML = `<span>${escapeHtml(texte)}</span>${bouton ? `<button type="button" class="ev-btn" id="ev-nav-alerte-btn">${escapeHtml(bouton.libelle)}</button>` : ""}`;
  el.classList.remove("hidden");
  if (bouton) $("ev-nav-alerte-btn").addEventListener("click", bouton.action);
}

function majEcran() {
  const route = etat.route;
  const pos = etat.pos;

  // Prochaine manœuvre
  const prochaines = route.instructions.filter((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE");
  const instr = prochaines[0];
  const ensuite = $("ev-nav-ensuite");
  ensuite.classList.add("hidden");
  if (etat.arrive) {
    $("ev-nav-fleche").textContent = "🏁";
    $("ev-nav-distance").textContent = "Arrivé";
    $("ev-nav-instruction").textContent = etat.destination.nom || "Destination";
  } else if (etat.aLaBorne) {
    $("ev-nav-fleche").textContent = "🔌";
    $("ev-nav-distance").textContent = "Recharge";
    $("ev-nav-instruction").textContent = etat.aLaBorne.nom_borne;
  } else if (instr) {
    const d = instr.offset - etat.offset;
    $("ev-nav-fleche").textContent = fleche(instr.manoeuvre);
    $("ev-nav-distance").textContent = distanceAffichee(d);
    $("ev-nav-instruction").textContent = instr.message || "Continuez tout droit";
    const suivante = prochaines[1];
    if (suivante && suivante.offset - instr.offset < 400) {
      ensuite.textContent = `Puis ${fleche(suivante.manoeuvre)} ${minusculeInitiale(suivante.message)}`;
      ensuite.classList.remove("hidden");
    }
  } else {
    $("ev-nav-fleche").textContent = "⬆️";
    $("ev-nav-distance").textContent = distanceAffichee(route.total - etat.offset);
    $("ev-nav-instruction").textContent = "Continuez jusqu'à la destination";
  }

  afficherVoies(instr);

  // Vitesse et limitation
  const kmh = Math.round((pos.vitesse || 0) * 3.6);
  const limite = route.limites[etat.idx];
  $("ev-nav-vitesse").innerHTML = `<strong>${kmh}</strong><span>km/h</span>`;
  $("ev-nav-vitesse").classList.toggle("exces", !!limite && kmh > limite + 3);
  $("ev-nav-limite").textContent = limite || "";
  $("ev-nav-limite").classList.toggle("hidden", !limite);
  surveillerVitesse(kmh, limite);

  // Prochaine borne
  const arret = etat.arretsRestants[0];
  const pctMaintenant = batterieEstimee();
  if (arret && !etat.aLaBorne) {
    const offsetBorne = route.troncons[0].fin;
    const reste = Math.max(0, offsetBorne - etat.offset);
    const pctBorne = pctMaintenant - (reste / 1000) * (etat.consoKwhKm / etat.capacite) * 100;
    const heureBorne = Date.now() + secondesRestantesJusqua(offsetBorne) * 1000;
    $("ev-nav-borne").innerHTML = `🔋 <strong>${escapeHtml(arret.nom_borne)}</strong> dans ${distanceAffichee(reste)} · ${heure(heureBorne)} · batterie ~${Math.round(pctBorne)} %`;
    $("ev-nav-borne").classList.remove("hidden");
    if (pctBorne < etat.margePct - 3 && !etat.alerteBatterieAffichee) {
      etat.alerteBatterieAffichee = true;
      afficherAlerte("⚠️ Batterie trop juste pour atteindre la borne prévue.", { libelle: "🔄 Recalculer", action: replanifier });
      parler("Attention, la batterie risque d'être trop juste pour atteindre la prochaine borne.");
    }
  } else {
    $("ev-nav-borne").classList.add("hidden");
  }

  // Bas de l'écran : heure d'arrivée, temps et km restants, batterie
  const chargesRestantes = etat.arretsRestants.reduce((s, a) => s + (a.temps_charge_min || 0) * 60, 0);
  const secondes = secondesRestantesJusqua(route.total) + chargesRestantes;
  $("ev-nav-eta").textContent = heure(Date.now() + secondes * 1000);
  $("ev-nav-reste-temps").textContent = formaterMinutes(secondes / 60);
  $("ev-nav-reste-km").textContent = `${Math.round((route.total - etat.offset) / 1000)}`;
  const pct = Math.max(0, Math.round(pctMaintenant));
  $("ev-nav-batt").textContent = `${pct} %`;
  $("ev-nav-batt").className = pct >= 50 ? "good" : pct >= 20 ? "warn" : "bad";
}

// ── Annonces vocales ────────────────────────────────────────────────────────

const NOMBRES = ["", "la", "les deux", "les trois", "les quatre"];

// « Prenez les deux voies de droite » : d'après les voies à suivre pour
// cette manœuvre. Rien si toutes les voies conviennent.
function phraseVoies(instr) {
  const section = etat.route.voies.find((v) => Math.abs(v.offset - instr.offset) < 40);
  if (!section) return "";
  const suivies = section.lanes.map((l, i) => (l.follow ? i : -1)).filter((i) => i >= 0);
  const n = section.lanes.length;
  const k = suivies.length;
  if (!k || k === n) return "";
  const pluriel = k > 1 ? "voies" : "voie";
  const debut = `Prenez ${NOMBRES[k] || k}`;
  if (suivies[0] === 0 && suivies[k - 1] === k - 1) return `${debut} ${pluriel} de gauche.`;
  if (suivies[k - 1] === n - 1 && suivies[0] === n - k) return `${debut} ${pluriel} de droite.`;
  if (k === 1 && n === 3 && suivies[0] === 1) return "Prenez la voie du milieu.";
  return k === 1 ? `Prenez la ${suivies[0] + 1}${suivies[0] === 0 ? "re" : "e"} voie en partant de la gauche.` : "";
}

// Double bip court (sans fichier son) : dépassement de la limitation.
let contexteAudio = null;
function bip() {
  if (!etat?.voix) return;
  try {
    contexteAudio ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = contexteAudio.currentTime;
    for (const debut of [0, 0.22]) {
      const osc = contexteAudio.createOscillator();
      const gain = contexteAudio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t + debut);
      gain.gain.exponentialRampToValueAtTime(0.25, t + debut + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + debut + 0.16);
      osc.connect(gain).connect(contexteAudio.destination);
      osc.start(t + debut);
      osc.stop(t + debut + 0.18);
    }
  } catch {
    // Son indisponible : l'alerte visuelle (compteur rouge) suffit.
  }
}

const TOLERANCE_VITESSE_KMH = 5;
const DUREE_AVANT_BIP_MS = 2000;

// Un seul bip par dépassement, après 2 s au-dessus (pas pour un pic de GPS).
function surveillerVitesse(kmh, limite) {
  const exces = !!limite && kmh > limite + TOLERANCE_VITESSE_KMH;
  if (!exces) {
    etat.excesDepuis = null;
    etat.bipFait = false;
    return;
  }
  etat.excesDepuis ??= Date.now();
  if (!etat.bipFait && Date.now() - etat.excesDepuis >= DUREE_AVANT_BIP_MS) {
    etat.bipFait = true;
    bip();
  }
}

function annonces() {
  if (etat.aLaBorne) return;
  const v = Math.max(etat.pos.vitesse || 0, 5);
  const instr = etat.route.instructions.find((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE");
  if (instr && !/WAYPOINT/.test(instr.manoeuvre)) {
    const d = instr.offset - etat.offset;
    const loin = Math.min(2000, Math.max(600, v * 60));
    const proche = Math.min(500, Math.max(120, v * 12));
    const maintenant = Math.min(60, Math.max(20, v * 3));
    const precedente = etat.route.instructions.filter((i) => i.offset < instr.offset).pop();
    const ecart = precedente ? instr.offset - precedente.offset : Infinity;
    if (d <= maintenant && !instr.annonces.has(3)) {
      instr.annonces.add(1).add(2).add(3);
      parler(instr.message, true);
    } else if (d <= proche && d > maintenant && !instr.annonces.has(2)) {
      instr.annonces.add(1).add(2);
      parler(`Dans ${distanceParlee(d)}, ${minusculeInitiale(instr.message)}. ${phraseVoies(instr)}`, true);
    } else if (d <= loin && d > proche && ecart > loin + 200 && !instr.annonces.has(1)) {
      instr.annonces.add(1);
      parler(`Dans ${distanceParlee(d)}, ${minusculeInitiale(instr.message)}. ${phraseVoies(instr)}`);
    }
  }

  const arret = etat.arretsRestants[0];
  if (arret) {
    const reste = etat.route.troncons[0].fin - etat.offset;
    for (const seuil of [20000, 2000]) {
      if (reste <= seuil && reste > seuil / 4 && !etat.annoncesBornes.has(seuil)) {
        etat.annoncesBornes.add(seuil);
        parler(`Borne de recharge ${arret.nom_borne} dans ${distanceParlee(reste)}.`);
      }
    }
  }
}

// ── Arrivées ────────────────────────────────────────────────────────────────

function arriveeBorne(arret) {
  etat.aLaBorne = arret;
  parler(
    `Vous êtes arrivé à la borne ${arret.nom_borne}. Rechargez jusqu'à ${arret.pct_depart_borne} pour cent, environ ${arret.temps_charge_min} minutes.`,
    true,
  );
  const carteBorne = $("ev-nav-etape-borne");
  carteBorne.innerHTML = `
    <div class="ev-nav-carte-titre">🔌 ${escapeHtml(arret.nom_borne)}</div>
    <div>Recharge conseillée : <strong>${arret.pct_arrivee_borne} % → ${arret.pct_depart_borne} %</strong> · environ <strong>${arret.temps_charge_min} min</strong> à ${arret.puissance_kw} kW</div>
    <div class="ev-nav-carte-sous">${escapeHtml(arret.adresse || "")}</div>
    <label class="ev-champ">Batterie affichée par la voiture à l'arrivée : <span id="ev-nav-arrivee-val" class="ev-valeur">${Math.round(batterieEstimee())}</span> %
      <input type="range" min="0" max="100" value="${Math.round(batterieEstimee())}" id="ev-nav-arrivee-input" class="ev-curseur">
    </label>
    <label class="ev-champ">Batterie en repartant : <span id="ev-nav-reprise-val" class="ev-valeur">${arret.pct_depart_borne}</span> %
      <input type="range" min="5" max="100" value="${arret.pct_depart_borne}" id="ev-nav-reprise-input" class="ev-curseur">
    </label>
    <button type="button" id="ev-nav-reprendre-btn" class="ev-btn-principal">▶ Reprendre la route</button>`;
  carteBorne.classList.remove("hidden");
  $("ev-nav-reprise-input").addEventListener("input", (e) => ($("ev-nav-reprise-val").textContent = e.target.value));
  $("ev-nav-arrivee-input").addEventListener("input", (e) => ($("ev-nav-arrivee-val").textContent = e.target.value));
  const pctEstime = batterieEstimee();
  $("ev-nav-reprendre-btn").addEventListener("click", () => {
    const pctRepart = Number($("ev-nav-reprise-input").value);
    const pctArrivee = Number($("ev-nav-arrivee-input").value);
    // Batterie réelle indiquée : mesure de la consommation depuis le dernier repère.
    if (!etat.demo && Math.abs(pctArrivee - pctEstime) >= 1) mesurerConso(pctArrivee);
    // Journal des recharges (pas en démo) : kWh réellement ajoutés d'après
    // la batterie à l'arrivée et celle indiquée au départ.
    const kwh = Math.round(((pctRepart - pctArrivee) * etat.capacite) / 10) / 10;
    if (!etat.demo && kwh >= 0.5) {
      ajouterAuJournal({ lieu: arret.nom_borne, kwh, cout_eur: Math.round(kwh * (arret.prix_kwh_eur ?? 0.45) * 100) / 100, prix_estime: arret.prix_est_estimation !== false, source: "navigation" });
    }
    etat.batterie = { refPct: pctRepart, refOdometre: etat.odometre };
    etat.arretsRestants.shift();
    etat.route.troncons.shift();
    etat.aLaBorne = null;
    etat.alerteBatterieAffichee = false;
    etat.annoncesBornes = new Set();
    carteBorne.classList.add("hidden");
    parler("C'est reparti.", true);
    majEcran();
    // Dernière borne quittée : on reprend le tracé choisi sans attendre.
    if (etat.plan.suivre_trace && !etat.arretsRestants.length) recalculer("reprise");
  });
  majEcran();
}

function arriveeDestination() {
  if (etat.arrive) return;
  etat.arrive = true;
  parler(`Vous êtes arrivé à destination. Batterie estimée : ${Math.round(batterieEstimee())} pour cent.`, true);
  const carteFin = $("ev-nav-etape-borne");
  carteFin.innerHTML = `
    <div class="ev-nav-carte-titre">🏁 Vous êtes arrivé</div>
    <div>${escapeHtml(etat.destination.nom || "")}</div>
    <div>Batterie estimée : <strong>${Math.round(batterieEstimee())} %</strong></div>
    <button type="button" id="ev-nav-terminer-btn" class="ev-btn-principal">Terminer</button>`;
  carteFin.classList.remove("hidden");
  $("ev-nav-terminer-btn").addEventListener("click", () => arreterNavigation());
}

// ── Bornes affichées pendant la conduite ────────────────────────────────────

async function rafraichirBornesProches() {
  if (!etat?.pos) return;
  const pos = etat.pos;
  const maintenant = Date.now();
  if (
    etat.posBornes &&
    maintenant - etat.dernierFetchBornes < DELAI_BORNES_MS &&
    haversineKm(pos.lat, pos.lon, etat.posBornes.lat, etat.posBornes.lon) < DISTANCE_MIN_RAFRAICHIR_BORNES_KM
  ) {
    return;
  }
  etat.dernierFetchBornes = maintenant;
  etat.posBornes = { lat: pos.lat, lon: pos.lon };
  const jeton = ++etat.jetonBornes;
  const { openChargeMap } = getApiKeys();
  const [res, officielles] = await Promise.all([
    openChargeMap ? rechercherBornesZone(openChargeMap, pos.lat, pos.lon, { rayonKm: RAYON_BORNES_KM, maxResultats: 60 }) : Promise.resolve({ ok: false, bornes: [] }),
    stationsOfficiellesZone(pos.lat, pos.lon, RAYON_BORNES_KM, { maxLignes: 300 }),
  ]);
  if (!etat || jeton !== etat.jetonBornes) return;
  vue.afficherBornes(fusionnerBornes(res.ok ? res.bornes : [], officielles.bornes), () => {});
  vue.montrerBornes(true);
}

// ── Recalculs ───────────────────────────────────────────────────────────────

async function recalculer(raison) {
  if (!etat || etat.recalculEnCours || etat.demo) return;
  etat.recalculEnCours = true;
  etat.dernierRecalcul = Date.now();
  if (raison === "hors_route") {
    afficherAlerte("🔄 Recalcul de l'itinéraire…");
    parler("Recalcul de l'itinéraire.", true);
  }
  const ancienneDuree = secondesRestantesJusqua(etat.route.total);
  const route = await calculerRouteNav(etat.pos, etat.pos.cap);
  if (!etat) return;
  etat.recalculEnCours = false;
  etat.dernierTrafic = Date.now();
  if (!route) {
    if (raison === "hors_route") afficherAlerte("⚠️ Recalcul impossible pour le moment (réseau ?). Nouvel essai sous peu.");
    return;
  }
  installerRoute(route);
  etat.horsRoute = 0;
  afficherAlerte(null);
  if (raison === "trafic") {
    const gain = ancienneDuree - secondesRestantesJusqua(route.total);
    if (gain > 300) parler(`Itinéraire plus rapide trouvé, ${Math.round(gain / 60)} minutes de gagnées.`);
  }
  majEcran();
}

async function replanifier() {
  if (!etat?.onReplanifier) return;
  afficherAlerte("🔄 Recalcul des recharges depuis ta position…");
  const pct = Math.max(1, Math.round(batterieEstimee()));
  const nouveauPlan = await etat.onReplanifier(`${etat.pos.lat.toFixed(5)},${etat.pos.lon.toFixed(5)}`, pct);
  if (!etat) return;
  if (!nouveauPlan?.ok) {
    afficherAlerte(`⚠️ ${nouveauPlan?.erreur || "Recalcul impossible."}`);
    return;
  }
  etat.plan = nouveauPlan;
  etat.indiceTrace = 0;
  etat.arretsRestants = [...(nouveauPlan.arrets || [])];
  etat.batterie = { refPct: pct, refOdometre: etat.odometre };
  etat.alerteBatterieAffichee = false;
  const route = await calculerRouteNav(etat.pos, etat.pos.cap);
  if (route) installerRoute(route);
  afficherAlerte(null);
  parler(
    nouveauPlan.nb_arrets ? `Nouveau plan : ${nouveauPlan.nb_arrets} arrêt${nouveauPlan.nb_arrets > 1 ? "s" : ""}, le prochain à ${nouveauPlan.arrets[0].nom_borne}.` : "Nouveau plan : plus besoin de recharger.",
    true,
  );
  majEcran();
}

// ── Réception des positions ─────────────────────────────────────────────────

function surPosition(p) {
  if (!etat?.route) return;
  const precedent = etat.pos;
  if (!Number.isFinite(p.vitesse) && precedent) {
    const dt = (p.t - precedent.t) / 1000;
    p.vitesse = dt > 0 ? (haversineKm(precedent.lat, precedent.lon, p.lat, p.lon) * 1000) / dt : 0;
  }
  const m = projeter(p.lat, p.lon, etat.idx);
  const [lonA, latA] = etat.route.coords[m.i];
  const [lonB, latB] = etat.route.coords[Math.min(m.i + 1, etat.route.coords.length - 1)];
  const capRoute = capEntre(latA, lonA, latB, lonB);
  if (!Number.isFinite(p.cap) || (p.vitesse || 0) < 2) p.cap = m.d < 30 ? capRoute : precedent?.cap ?? capRoute;

  const avance = m.offset - etat.offset;
  if (avance > 0 && avance < 20000) etat.odometre += avance;
  etat.idx = m.i;
  etat.offset = m.offset;
  etat.pos = p;

  // Hors itinéraire : plusieurs positions de suite trop loin du tracé
  const seuil = Math.max(40, (p.precision || 20) * 1.5);
  etat.horsRoute = m.d > seuil && (p.vitesse || 0) > 2 ? etat.horsRoute + 1 : 0;
  if (etat.horsRoute >= 3 && Date.now() - etat.dernierRecalcul > DELAI_MIN_RECALCUL_MS) recalculer("hors_route");
  else if (!etat.demo && Date.now() - etat.dernierTrafic > DELAI_TRAFIC_MS) recalculer("trafic");

  // Arrivée à une borne ou à destination
  const arret = etat.arretsRestants[0];
  if (arret && !etat.aLaBorne) {
    const finTroncon = etat.route.troncons[0].fin;
    if (etat.offset >= finTroncon - 40 || haversineKm(p.lat, p.lon, arret.lat, arret.lon) < 0.06) arriveeBorne(arret);
  }
  if (!arret && (etat.offset >= etat.route.total - 30 || haversineKm(p.lat, p.lon, etat.destination.lat, etat.destination.lon) < 0.04)) arriveeDestination();

  etat.zoom = zoomNavigation((p.vitesse || 0) * 3.6, etat.zoom);
  programmerAnimation(p, m);
  annonces();
  majEcran();
  rafraichirBornesProches();
}

// ── Animation fluide de la voiture ──────────────────────────────────────────
// Le GPS ne donne qu'une position par seconde : afficher chacune telle
// quelle fait avancer la voiture par sauts. On glisse donc le long de la
// route entre deux positions (en visant là où la voiture sera à la
// suivante, pour ne pas afficher avec une seconde de retard), et la
// rotation et le zoom de la carte suivent en douceur.

const CONSTANTE_CAP_MS = 350;
const CONSTANTE_ZOOM_MS = 700;
const INTERVALLE_TRACE_MS = 120;

function programmerAnimation(p, m) {
  const maintenant = performance.now();
  const duree = etat.derniereFixe ? Math.min(1500, Math.max(300, maintenant - etat.derniereFixe)) : 0;
  etat.derniereFixe = maintenant;

  let vers;
  if (m.d < 30) {
    vers = { offset: Math.min(etat.route.total, m.offset + (p.vitesse || 0) * (duree / 1000)) };
    // Petit retour en arrière dû à l'anticipation (la voiture a freiné) : on attend.
    const avant = etat.aff?.offset;
    if (avant != null && vers.offset < avant && avant - vers.offset < 15) vers.offset = avant;
  } else {
    vers = { lat: p.lat, lon: p.lon, cap: p.cap, offset: null };
  }
  if (!etat.aff) {
    const pt = vers.offset != null ? pointSurRoute(vers.offset) : vers;
    etat.aff = { lat: pt.lat, lon: pt.lon, cap: pt.cap || 0, zoom: etat.zoom, offset: vers.offset };
  }
  etat.anim = { depuis: { ...etat.aff }, vers, debut: maintenant, duree: Math.max(1, duree) };
  if (!etat.raf) etat.raf = requestAnimationFrame(boucleAnimation);
}

function boucleAnimation(t) {
  if (!etat?.route || !etat.anim) {
    if (etat) etat.raf = null;
    return;
  }
  const { depuis, vers, debut, duree } = etat.anim;
  const k = Math.min(1, (t - debut) / duree);
  const dtImage = etat.derniereImage ? Math.min(100, t - etat.derniereImage) : 16;
  etat.derniereImage = t;
  const aff = etat.aff;

  let capCible;
  let indice = etat.idx;
  if (vers.offset != null && depuis.offset != null && Math.abs(vers.offset - depuis.offset) < 800) {
    aff.offset = depuis.offset + (vers.offset - depuis.offset) * k;
    const pt = pointSurRoute(aff.offset);
    aff.lat = pt.lat;
    aff.lon = pt.lon;
    capCible = pt.cap;
    indice = pt.i;
  } else {
    const but = vers.offset != null ? pointSurRoute(vers.offset) : vers;
    aff.lat = depuis.lat + (but.lat - depuis.lat) * k;
    aff.lon = depuis.lon + (but.lon - depuis.lon) * k;
    capCible = Number.isFinite(but.cap) ? but.cap : aff.cap;
    aff.offset = k >= 1 ? vers.offset : null;
  }

  const ecartCap = ((capCible - aff.cap + 540) % 360) - 180;
  aff.cap = (aff.cap + ecartCap * Math.min(1, dtImage / CONSTANTE_CAP_MS) + 360) % 360;
  const ecartZoom = etat.zoom - aff.zoom;
  aff.zoom = Math.abs(ecartZoom) < 0.01 ? etat.zoom : aff.zoom + ecartZoom * Math.min(1, dtImage / CONSTANTE_ZOOM_MS);

  vue.majVoiture(aff.lat, aff.lon, aff.cap);
  if (etat.suivi) vue.cameraNavigation(aff.lat, aff.lon, aff.cap, aff.zoom, etat.sensDeMarche, false);
  if (t - (etat.derniereTrace || 0) > INTERVALLE_TRACE_MS || k >= 1) {
    etat.derniereTrace = t;
    vue.majProgressionNavigation(etat.route.coords, indice, aff.lat, aff.lon);
  }

  // Au repos (animation finie, rotation et zoom stabilisés) : plus rien à
  // redessiner avant la prochaine position, on économise la batterie.
  if (k >= 1 && Math.abs(ecartCap) < 0.5 && Math.abs(ecartZoom) < 0.01) {
    etat.raf = null;
    etat.derniereImage = null;
    return;
  }
  etat.raf = requestAnimationFrame(boucleAnimation);
}

// Comme un GPS : large sur autoroute, rapproché en ville et à l'approche
// d'une manœuvre (rond-point, sortie…). Les seuils de vitesse ont 5 km/h
// d'hystérésis pour que la carte ne « pompe » pas autour de 50 km/h.
const PALIERS_ZOOM = [
  { min: 90, zoom: 15 },
  { min: 50, zoom: 16 },
  { min: 30, zoom: 17 },
  { min: -1, zoom: 18 },
];
const ZOOM_MANOEUVRE = 18;

function zoomNavigation(kmh, zoomActuel) {
  const instr = etat.route.instructions.find((i) => i.offset > etat.offset + 8 && i.type !== "LOCATION_DEPARTURE" && !/WAYPOINT|ARRIVE/.test(i.manoeuvre || ""));
  const distanceManoeuvre = instr ? instr.offset - etat.offset : Infinity;
  // ~12 s de trajet, au moins 150 m et au plus 350 m avant la manœuvre
  const apresManoeuvre = etat.zoomManoeuvre;
  etat.zoomManoeuvre = distanceManoeuvre < Math.min(350, Math.max(150, (kmh / 3.6) * 12));
  if (etat.zoomManoeuvre) return ZOOM_MANOEUVRE;

  const cible = PALIERS_ZOOM.find((p) => kmh > p.min).zoom;
  if (!Number.isFinite(zoomActuel) || apresManoeuvre || Math.abs(cible - zoomActuel) > 1) return cible;
  // Palier voisin : on ne change que si la vitesse a franchi le seuil de 5 km/h.
  const seuil = PALIERS_ZOOM.find((p) => p.zoom === Math.min(cible, zoomActuel)).min;
  return Math.abs(kmh - seuil) >= 5 ? cible : zoomActuel;
}

// ── Source de position : GPS réel ───────────────────────────────────────────

function demarrerGps() {
  etat.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (etat?.alerteGps) {
        etat.alerteGps = false;
        afficherAlerte(null);
      }
      surPosition({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        vitesse: pos.coords.speed ?? NaN,
        cap: pos.coords.heading ?? NaN,
        precision: pos.coords.accuracy,
        t: pos.timestamp,
      });
    },
    (err) => {
      if (!etat) return;
      etat.alerteGps = true;
      afficherAlerte(err.code === err.PERMISSION_DENIED ? "⚠️ Accès à la position refusé : autorise la localisation pour cette appli." : "⚠️ Signal GPS perdu, recherche…");
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
}

// ── Source de position : mode démo (trajet simulé) ──────────────────────────

function pointSurRoute(offset) {
  const { coords, cum } = etat.route;
  // Recherche dichotomique : appelée à chaque image pendant l'animation.
  let bas = 0;
  let haut = cum.length - 2;
  while (bas < haut) {
    const milieu = (bas + haut + 1) >> 1;
    if (cum[milieu] <= offset) bas = milieu;
    else haut = milieu - 1;
  }
  const i = Math.max(0, bas);
  const t = cum[i + 1] > cum[i] ? Math.max(0, Math.min(1, (offset - cum[i]) / (cum[i + 1] - cum[i]))) : 0;
  const [lonA, latA] = coords[i];
  const [lonB, latB] = coords[i + 1];
  return { lat: latA + t * (latB - latA), lon: lonA + t * (lonB - lonA), cap: capEntre(latA, lonA, latB, lonB), i };
}

// La voiture simulée roule un peu sous la limitation et ralentit avant
// chaque manœuvre (rond-point, sortie…), comme un vrai conducteur.
function vitesseDemoKmh(offset, i) {
  let kmh = etat.route.limites[i] ? etat.route.limites[i] * 0.93 : 85;
  const instr = etat.route.instructions.find((x) => x.offset > offset && x.type !== "LOCATION_DEPARTURE");
  const d = instr ? instr.offset - offset : Infinity;
  if (d < 60) kmh = Math.min(kmh, 30);
  else if (d < 250) kmh = Math.min(kmh, 30 + (d - 60) * 0.25);
  return kmh;
}

function demarrerDemo() {
  let offset = etat.offset;
  const acceleration = window.TRAJETVE_ACCELERATION_DEMO || ACCELERATION_DEMO;
  etat.demoTimer = setInterval(() => {
    if (!etat || etat.aLaBorne || etat.arrive) return;
    const p0 = pointSurRoute(offset);
    const kmh = vitesseDemoKmh(offset, p0.i);
    offset = Math.max(offset, etat.offset) + (kmh / 3.6) * acceleration;
    if (offset > etat.route.total) offset = etat.route.total;
    const p = pointSurRoute(offset);
    surPosition({ lat: p.lat, lon: p.lon, vitesse: kmh / 3.6, cap: p.cap, precision: 5, t: Date.now() });
  }, 1000);
}

async function garderEcranAllume() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") etat.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* non supporté ou refusé : l'écran pourra s'éteindre */
  }
}

function surVisibilite() {
  if (etat && document.visibilityState === "visible") garderEcranAllume();
}

// ── Démarrage / arrêt ───────────────────────────────────────────────────────

let cable = false;

function cablerBoutons() {
  if (cable) return;
  cable = true;
  $("ev-nav-stop-btn").addEventListener("click", () => {
    if (confirm("Arrêter la navigation ?")) arreterNavigation();
  });
  $("ev-nav-voix-btn").addEventListener("click", () => {
    etat.voix = !etat.voix;
    $("ev-nav-voix-btn").textContent = etat.voix ? "🔊" : "🔇";
    if (!etat.voix) speechSynthesis.cancel();
  });
  $("ev-nav-orientation-btn").addEventListener("click", () => {
    etat.sensDeMarche = !etat.sensDeMarche;
    $("ev-nav-orientation-btn").textContent = etat.sensDeMarche ? "🧭" : "🅽";
    etat.suivi = true;
    $("ev-nav-recentrer-btn").classList.add("hidden");
    if (etat.pos) vue.cameraNavigation(etat.pos.lat, etat.pos.lon, etat.pos.cap, 16, etat.sensDeMarche, false);
  });
  $("ev-nav-3d-btn").addEventListener("click", basculerVue);
  $("ev-nav-apercu-btn").addEventListener("click", () => {
    etat.suivi = false;
    $("ev-nav-recentrer-btn").classList.remove("hidden");
    vue.apercuNavigation(etat.route.coords.slice(etat.idx));
  });
  $("ev-nav-recentrer-btn").addEventListener("click", () => {
    etat.suivi = true;
    $("ev-nav-recentrer-btn").classList.add("hidden");
    if (etat.pos) vue.cameraNavigation(etat.pos.lat, etat.pos.lon, etat.pos.cap, 16, etat.sensDeMarche, false);
  });
  $("ev-nav-batt-btn").addEventListener("click", () => {
    const panneau = $("ev-nav-batterie-panneau");
    const ouvert = !panneau.classList.contains("hidden");
    if (ouvert) {
      panneau.classList.add("hidden");
      return;
    }
    const pct = Math.max(1, Math.round(batterieEstimee()));
    $("ev-nav-batt-input").value = String(pct);
    $("ev-nav-batt-val").textContent = String(pct);
    panneau.classList.remove("hidden");
  });
  $("ev-nav-batt-input").addEventListener("input", (e) => ($("ev-nav-batt-val").textContent = e.target.value));
  $("ev-nav-batt-ok").addEventListener("click", () => {
    if (!etat.demo) mesurerConso(Number($("ev-nav-batt-input").value));
    etat.batterie = { refPct: Number($("ev-nav-batt-input").value), refOdometre: etat.odometre };
    etat.alerteBatterieAffichee = false;
    $("ev-nav-batterie-panneau").classList.add("hidden");
    majEcran();
  });
  $("ev-nav-replan-btn").addEventListener("click", () => {
    if (!etat.demo) mesurerConso(Number($("ev-nav-batt-input").value));
    etat.batterie = { refPct: Number($("ev-nav-batt-input").value), refOdometre: etat.odometre };
    $("ev-nav-batterie-panneau").classList.add("hidden");
    replanifier();
  });
  window.addEventListener("popstate", () => {
    if (etat) arreterNavigation({ depuisRetour: true });
  });
  document.addEventListener("visibilitychange", surVisibilite);
}

// Même fond (nuit, jour, satellite) et mêmes réglages que la carte des bornes.
function optionsCarte3D() {
  const options = carte2D.optionsCarte3D();
  // Sans réseau, seule la carte OpenFreeMap a pu être gardée.
  return navigator.onLine === false ? { ...options, fournisseur: "libre", fond: options.fond === "satellite" ? "sombre" : options.fond } : options;
}

// Fournisseur choisi refusé, l'autre a pris le relais : on le dit sans insister.
function signalerRemplacementCarte() {
  const texte = carte3D.dernierAvertissement();
  if (!texte) return;
  const message = `ℹ️ ${texte}.`;
  afficherAlerte(message);
  setTimeout(() => {
    if (etat && $("ev-nav-alerte").textContent === message) afficherAlerte(null);
  }, 12000);
}

function surDeplacementManuel() {
  if (!etat) return;
  etat.suivi = false;
  $("ev-nav-recentrer-btn").classList.remove("hidden");
}

function majBouton3D() {
  const btn = $("ev-nav-3d-btn");
  btn.textContent = vue === carte3D ? "3D" : "2D";
  btn.title = vue === carte3D ? "Vue 3D (toucher pour passer en 2D)" : "Vue 2D (toucher pour passer en 3D)";
}

// Change de carte en pleine navigation : tout ce qui est dessiné (tracé,
// bornes, voiture) est refait sur la nouvelle.
function changerVue(nouvelle) {
  if (nouvelle === vue) return;
  vue.montrerBornes(false);
  vue.quitterNavigation();
  vue = nouvelle;
  vue.entrerNavigation({ onDeplacementManuel: surDeplacementManuel });
  if (etat.route) vue.dessinerRouteNavigation(etat.route.coords, etat.arretsRestants, etat.destination);
  etat.posBornes = null;
  rafraichirBornesProches();
  etat.suivi = true;
  $("ev-nav-recentrer-btn").classList.add("hidden");
  const a = etat.aff;
  if (a && etat.route) {
    vue.majVoiture(a.lat, a.lon, a.cap);
    vue.cameraNavigation(a.lat, a.lon, a.cap, a.zoom, etat.sensDeMarche, false);
    vue.majProgressionNavigation(etat.route.coords, etat.idx, a.lat, a.lon);
  }
  majBouton3D();
}

async function basculerVue() {
  if (!etat || etat.basculeEnCours) return;
  etat.basculeEnCours = true;
  const vers3D = vue !== carte3D;
  sauverReglages({ vue_3d: vers3D });
  let nouvelle = carte2D;
  if (vers3D) {
    $("ev-nav-3d-btn").textContent = "…";
    if (await carte3D.preparer(optionsCarte3D())) {
      nouvelle = carte3D;
      signalerRemplacementCarte();
    } else afficherAlerte(`⚠️ Vue 3D indisponible : ${carte3D.derniereErreur() || "raison inconnue"}. On reste en 2D.`);
  }
  if (!etat) return;
  etat.basculeEnCours = false;
  changerVue(nouvelle);
  majBouton3D();
}

// La 3D tombe en panne en route : on repasse en 2D sans changer la
// préférence (la 3D sera retentée au prochain trajet).
carte3D.definirSurPanne((raison) => {
  if (!etat || vue !== carte3D) return;
  changerVue(carte2D);
  const texte = `⚠️ Vue 3D interrompue (${raison}) : passage en 2D. Touchez « 2D » pour réessayer.`;
  afficherAlerte(texte);
  setTimeout(() => {
    if (etat && $("ev-nav-alerte").textContent === texte) afficherAlerte(null);
  }, 15000);
});

export function navigationActive() {
  return !!etat;
}

// plan : résultat du planificateur ; options : réglages du trajet ;
// onReplanifier(depart, chargePct) -> nouveau plan ; onFin() à l'arrêt.
export async function demarrerNavigation(plan, { options = {}, demo = false, chargeDepartPct, onReplanifier, onFin } = {}) {
  if (etat) return;
  if (!getApiKeys().tomtom) {
    alert("Clé TomTom manquante : ajoute-la dans l'onglet 🚗 Profil.");
    return;
  }
  cablerBoutons();
  etat = {
    plan,
    options,
    demo,
    onReplanifier,
    onFin,
    destination: { lat: plan.to_lat, lon: plan.to_lon, nom: plan.to_name },
    arretsRestants: [...(plan.arrets || [])],
    route: null,
    pos: null,
    idx: 0,
    offset: 0,
    odometre: 0,
    horsRoute: 0,
    dernierRecalcul: 0,
    dernierTrafic: Date.now(),
    dernierFetchBornes: 0,
    indiceTrace: 0,
    posBornes: null,
    jetonBornes: 0,
    annoncesBornes: new Set(),
    capacite: obtenirProfilVehicule().capacite_kwh,
    consoKwhKm: (plan.energie_totale_necessaire_kwh || 13) / Math.max(1, plan.distance_km),
    margePct: options.marge_pct ?? plan.arrets?.[0]?.pct_arrivee_borne ?? 12,
    batterie: { refPct: chargeDepartPct ?? 80, refOdometre: 0 },
    voix: true,
    sensDeMarche: true,
    suivi: true,
  };

  document.body.classList.add("ev-mode-navigation");
  document.body.classList.toggle("ev-mode-voiture", lireReglages().mode_voiture === true);
  $("ev-navigation").classList.remove("hidden");
  $("ev-nav-etape-borne").classList.add("hidden");
  $("ev-nav-batterie-panneau").classList.add("hidden");
  $("ev-nav-recentrer-btn").classList.add("hidden");
  $("ev-nav-voix-btn").textContent = "🔊";
  $("ev-nav-orientation-btn").textContent = "🧭";
  $("ev-nav-fleche").textContent = "⏳";
  $("ev-nav-distance").textContent = "";
  $("ev-nav-instruction").textContent = "Calcul du guidage…";
  afficherAlerte(null);
  history.pushState({ navigation: true }, "");
  const veut3D = lireReglages().vue_3d !== false;
  if (veut3D) $("ev-nav-instruction").textContent = "Préparation de la vue 3D…";
  vue = veut3D && (await carte3D.preparer(optionsCarte3D())) ? carte3D : carte2D;
  if (!etat) return;
  majBouton3D();
  if (veut3D && vue === carte2D) afficherAlerte(`⚠️ Vue 3D indisponible : ${carte3D.derniereErreur() || "raison inconnue"}. Navigation en 2D.`);
  else if (vue === carte3D) signalerRemplacementCarte();
  $("ev-nav-instruction").textContent = "Calcul du guidage…";
  vue.entrerNavigation({ onDeplacementManuel: surDeplacementManuel });
  garderEcranAllume();

  // Position de départ : GPS réel, ou début du trajet en démo
  const depart = demo
    ? { lat: plan.from_lat, lon: plan.from_lon, vitesse: 0, cap: NaN, precision: 5, t: Date.now() }
    : await new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, vitesse: p.coords.speed ?? NaN, cap: p.coords.heading ?? NaN, precision: p.coords.accuracy, t: p.timestamp }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
        ),
      );
  if (!depart) {
    afficherAlerte("⚠️ Position GPS introuvable. Autorise la localisation, ou essaie le mode démo.");
    $("ev-nav-instruction").textContent = "En attente du GPS…";
    return;
  }
  if (!etat) return;
  etat.pos = depart;
  const route = await calculerRouteNav(depart, depart.cap);
  if (!etat) return;
  if (!route) {
    afficherAlerte("⚠️ Impossible de calculer le guidage (clé TomTom ou réseau).", { libelle: "Arrêter", action: () => arreterNavigation() });
    return;
  }
  installerRoute(route);
  const premiere = route.instructions.find((i) => i.type !== "LOCATION_DEPARTURE");
  parler(`C'est parti. ${premiere ? premiere.message : ""}`, true);
  if (demo) demarrerDemo();
  else {
    demarrerGps();
    etat.minuteurSauvegarde = setInterval(sauverNavigation, INTERVALLE_SAUVEGARDE_MS);
    window.addEventListener("pagehide", sauverNavigation);
  }
  surPosition({ ...depart, t: Date.now() });
}

// ── Reprise après coupure ───────────────────────────────────────────────────
// Appel, écran verrouillé, appli fermée par Android : la navigation en cours
// est gardée (hors clé « trajetve_ » : pas dans les sauvegardes), et proposée
// à la réouverture pendant un moment.

const CLE_NAVIGATION = "tve_navigation_en_cours";
const INTERVALLE_SAUVEGARDE_MS = 15000;
const DUREE_REPRISE_MS = 45 * 60 * 1000;

function sauverNavigation() {
  if (!etat || etat.demo || etat.arrive) return;
  try {
    const arretsFaits = (etat.plan.arrets || []).length - etat.arretsRestants.length;
    localStorage.setItem(CLE_NAVIGATION, JSON.stringify({ ts: Date.now(), plan: etat.plan, options: etat.options, arrets_faits: Math.max(0, arretsFaits), batterie_pct: Math.round(batterieEstimee()) }));
  } catch {
    // Stockage plein : la reprise ne sera simplement pas proposée.
  }
}

export function oublierNavigationInterrompue() {
  localStorage.removeItem(CLE_NAVIGATION);
}

// { plan, options, batterie_pct, destination } si une navigation a été
// interrompue récemment, sinon null.
export function navigationInterrompue() {
  try {
    const s = JSON.parse(localStorage.getItem(CLE_NAVIGATION));
    if (!s || Date.now() - s.ts > DUREE_REPRISE_MS) return null;
    return { plan: { ...s.plan, arrets: (s.plan.arrets || []).slice(s.arrets_faits) }, options: s.options, batterie_pct: s.batterie_pct, destination: s.plan.to_name };
  } catch {
    return null;
  }
}

export function arreterNavigation({ depuisRetour = false } = {}) {
  if (!etat) return;
  clearInterval(etat.minuteurSauvegarde);
  window.removeEventListener("pagehide", sauverNavigation);
  oublierNavigationInterrompue();
  if (etat.watchId !== undefined) navigator.geolocation.clearWatch(etat.watchId);
  if (etat.demoTimer) clearInterval(etat.demoTimer);
  if (etat.raf) cancelAnimationFrame(etat.raf);
  try {
    etat.wakeLock?.release();
  } catch {
    /* déjà relâché */
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const onFin = etat.onFin;
  const plan = etat.plan;
  etat = null;
  vue.montrerBornes(false);
  vue.quitterNavigation();
  document.body.classList.remove("ev-mode-navigation", "ev-mode-voiture");
  $("ev-navigation").classList.add("hidden");
  if (!depuisRetour && history.state?.navigation) {
    retourEnCours = true;
    history.back();
  }
  onFin?.(plan);
}

// Le "retour" déclenché par l'arrêt de la navigation ne doit pas être pris
// par l'interface pour un appui sur le bouton retour d'Android.
let retourEnCours = false;
export function retourNavigationEnCours() {
  const r = retourEnCours;
  retourEnCours = false;
  return r;
}
