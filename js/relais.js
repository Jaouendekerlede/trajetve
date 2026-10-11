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

// État du véhicule publié par JARVIS (batterie_pct, autonomie_km, en_charge,
// branche...), ou null si non configuré/indisponible/périmé (>15 min).
export async function lireEtatVehiculeRelais() {
  const base = urlRelais();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/vehicule`, { signal: avecDelai() });
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
    const r = await fetch(`${base}/trajet-prevu`, { signal: avecDelai() });
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
