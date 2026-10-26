// Relais partagé optionnel (petit serveur Cloudflare Worker déployé par
// l'utilisateur -- voir Sauvegarde Projets 16-09-2026/TrajetVE-Relais/
// LISEZ-MOI.md) : relaie l'état réel du véhicule lu par JARVIS (Bluelink,
// que TrajetVE ne peut pas interroger lui-même -- API sans CORS, testé le
// 2026-10-09) et partage les signalements de bornes entre tous les
// utilisateurs de TrajetVE, au lieu de rester connus seulement sur le
// téléphone qui a signalé.
//
// Sans URL configurée (réglages.relais_url vide), toutes les fonctions
// ci-dessous sont des no-op silencieux -- l'appli continue de fonctionner
// normalement en local, c'est une amélioration et jamais une dépendance.

import { lireReglages } from "./storage.js";

const DELAI_MS = 5000;

function urlRelais() {
  return (lireReglages().relais_url || "").trim().replace(/\/+$/, "");
}

export function relaisConfigure() {
  return !!urlRelais();
}

function avecDelai(signal) {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(DELAI_MS) : signal;
}

// Secret de LECTURE (distinct de celui de JARVIS, qui protège l'écriture) --
// demande explicite de l'utilisateur le 2026-10-26 : sans lui, n'importe
// qui découvrant l'adresse du relais pouvait lire la position GPS en
// direct, le verrouillage, etc., sans authentification. Réglé une fois
// dans Profil, envoyé automatiquement ensuite. Absent : en-tête omis, le
// worker reste ouvert tant que ce secret n'est pas configuré côté serveur.
function enTetesLecture() {
  const secret = (lireReglages().relais_secret || "").trim();
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

// État du véhicule publié par JARVIS (batterie_pct, autonomie_km, en_charge,
// branche...), ou null si non configuré/indisponible/périmé (>15 min).
export async function lireEtatVehiculeRelais() {
  const base = urlRelais();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/vehicule`, { headers: enTetesLecture(), signal: avecDelai() });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.ok ? d : null;
  } catch {
    return null;
  }
}

// Destination probable publiée par JARVIS (agenda du jour) au moment du
// briefing "je pars en voiture" -- { destination, titre, heure, maj_ts } ou
// null si non configuré/indisponible/périmée (le worker l'expire après 4h,
// mais on revérifie aussi côté appli au cas où la pendule du serveur
// dérive). Demande explicite de l'utilisateur le 2026-10-11.
const DUREE_TRAJET_PREVU_MS = 4 * 3600 * 1000;

export async function trajetSuggereParJarvis() {
  const base = urlRelais();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/trajet-prevu`, { headers: enTetesLecture(), signal: avecDelai() });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.ok || !d.destination || Date.now() - (d.maj_ts || 0) > DUREE_TRAJET_PREVU_MS) return null;
    return d;
  } catch {
    return null;
  }
}

// type : "panne" | "retabli" | "manquante" (déjà fait en local avant cet
// appel, celui-ci n'est qu'un partage en plus) ou "libre" | "occupee"
// (occupation confirmée sur place, sans équivalent local -- demande
// explicite de l'utilisateur le 2026-10-11, pour compenser les opérateurs
// qui ne transmettent pas leur état officiel). Toujours best-effort, jamais
// bloquant.
export async function signalerBornePartage(lat, lon, type, extra = {}) {
  const base = urlRelais();
  if (!base) return;
  try {
    await fetch(`${base}/bornes/signalement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, type, ...extra }),
      signal: avecDelai(),
    });
  } catch {
    // Sans conséquence : le signalement local suffit à l'appareil qui a signalé.
  }
}

// Fiabilité des opérateurs (quels opérateurs transmettent vraiment leur
// occupation en temps réel, voir storage.js noterFiabiliteOperateur) --
// publiée sur le relais au fil de l'eau, pour que
// jarvis_ev_charge_runtime.py en profite aussi. Limité à une fois toutes
// les 5 min (une nouvelle observation à chaque borne consultée suffirait
// sinon à spammer le relais). Toujours best-effort. Demande explicite de
// l'utilisateur le 2026-10-11.
const DELAI_MIN_PUBLICATION_FIABILITE_MS = 5 * 60000;
let dernierePublicationFiabilite = 0;

export async function publierFiabiliteOperateurs(donnees) {
  const base = urlRelais();
  if (!base || Date.now() - dernierePublicationFiabilite < DELAI_MIN_PUBLICATION_FIABILITE_MS) return;
  dernierePublicationFiabilite = Date.now();
  try {
    await fetch(`${base}/fiabilite-operateurs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(donnees),
      signal: avecDelai(),
    });
  } catch {
    // Sans conséquence : la base locale reste à jour de toute façon.
  }
}

// Commande ponctuelle envoyée à JARVIS (ex: préchauffer la batterie en
// approchant d'une borne rapide, comme ABRP -- voir rappelsAvantBorne dans
// navigation.js). JARVIS interroge le relais toutes les ~90 s et agit une
// seule fois par "ts" ; toujours best-effort, jamais bloquant pour la
// navigation. Demande explicite de l'utilisateur le 2026-10-25.
export async function publierCommandeVehicule(action, extra = {}) {
  const base = urlRelais();
  if (!base) return;
  try {
    await fetch(`${base}/commande-vehicule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ts: Date.now(), ...extra }),
      signal: avecDelai(),
    });
  } catch {
    // Sans conséquence : au pire, l'utilisateur reçoit juste le rappel vocal existant.
  }
}

// Recharges réelles détectées par JARVIS via Bluelink (toute recharge, pas
// seulement celles faites en navigation guidée) -- voir
// jarvis_bluelink_runtime.boucle_detection_recharge. Lue à l'ouverture de
// l'écran Outils (ui.js) pour importer dans le Journal des recharges.
// Toujours best-effort, [] si non configuré/indisponible.
export async function rechargesDetecteesParJarvis() {
  const base = urlRelais();
  if (!base) return [];
  try {
    const r = await fetch(`${base}/recharge-detectee`, { headers: enTetesLecture(), signal: avecDelai() });
    if (!r.ok) return [];
    const d = await r.json();
    return d?.ok ? d.recharges || [] : [];
  } catch {
    return [];
  }
}

let cache = { cle: "", ts: 0, donnees: [] };
const DUREE_CACHE_MS = 5 * 60000;

// Signalements des AUTRES utilisateurs à proximité (rayonKm), mis en cache
// 5 min pour ne pas réinterroger à chaque rendu de la même zone.
export async function signalementsPartagesProches(lat, lon, rayonKm = 5) {
  const base = urlRelais();
  if (!base) return [];
  const cle = `${lat.toFixed(2)},${lon.toFixed(2)},${rayonKm}`;
  if (cache.cle === cle && Date.now() - cache.ts < DUREE_CACHE_MS) return cache.donnees;
  try {
    const r = await fetch(`${base}/bornes/signalements?lat=${lat}&lon=${lon}&rayon_km=${rayonKm}`, { signal: avecDelai() });
    const d = r.ok ? await r.json() : null;
    const donnees = d?.ok ? d.signalements : [];
    cache = { cle, ts: Date.now(), donnees };
    return donnees;
  } catch {
    return cache.cle === cle ? cache.donnees : [];
  }
}
