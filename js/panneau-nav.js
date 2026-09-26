// Contenu du panneau de direction (comme les panneaux routiers) et dessin
// du carrefour vu de dessus. Module sans écran ni réseau : testé à part.

import { lisser } from "./geo.js";

// « A11 » → classe de couleur des panneaux français : A et N en rouge,
// D en jaune, E en vert, M (métropole) en bleu clair.
export function classeNumero(numero) {
  const lettre = String(numero || "").trim().charAt(0).toUpperCase();
  return { A: "rouge", N: "rouge", D: "jaune", E: "vert", M: "cyan" }[lettre] || "gris";
}

export function estAutoroute(numero) {
  return /^A\s?\d/i.test(String(numero || "").trim());
}

// Textes du panneau : rue en gros (ou, à défaut, la direction), numéros de
// route, numéro de sortie, direction à suivre, et l'action en petit.
// instr : { message, rue, numeros, sortie, direction }.
export function textesPanneau(instr) {
  const message = instr.message || "Continuez tout droit";
  const numeros = instr.numeros || [];
  let action = message;
  for (const t of [instr.rue, numeros.join("/"), instr.direction]) {
    if (!t) continue;
    const i = action.indexOf(t);
    if (i > 0) action = action.slice(0, i);
  }
  action = action.replace(/[\s,]*(sur|à|au|dans|vers|par|direction)?\s*$/i, "").trim() || message;
  const rue = instr.rue || instr.direction || "";
  return {
    rue,
    action,
    // La direction est déjà en gros si la rue manque.
    direction: instr.rue ? instr.direction || "" : "",
    numeros,
    sortie: instr.sortie || "",
  };
}

const RAYON_VUE_M = 70;
let numeroDessin = 0;
const TAILLE_SVG = 100;

// Dessin du carrefour vu de dessus, l'arrivée en bas : les routes autour
// (OpenStreetMap) en clair, le chemin à suivre en blanc avec sa pointe.
// routes : [[lon, lat], …][] ; chemin : [lon, lat][] (de l'arrivée à la
// sortie) ; centre : [lon, lat] ; cap : direction d'arrivée (degrés).
export function svgCarrefour(routes, chemin, centre, cap) {
  const [lonC, latC] = centre;
  const kx = 111320 * Math.cos((latC * Math.PI) / 180);
  const ky = 110540;
  const t = (cap * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const echelle = (TAILLE_SVG * 0.46) / RAYON_VUE_M;
  const versSvg = ([lon, lat]) => {
    const x = (lon - lonC) * kx;
    const y = (lat - latC) * ky;
    return [TAILLE_SVG / 2 + (x * c - y * s) * echelle, TAILLE_SVG * 0.52 - (x * s + y * c) * echelle];
  };
  const chemins = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  // Routes dans un seul groupe translucide : pas de taches plus claires là
  // où elles se croisent.
  const fonds = routes
    .filter((r) => r.length >= 2)
    .map((r) => `<path d="${chemins(r.map(versSvg))}"/>`)
    .join("");
  const trace = lisser(chemin.map(versSvg));
  if (trace.length < 2) return "";
  const [xa, ya] = trace[trace.length - 2];
  const [xb, yb] = trace[trace.length - 1];
  const r = Math.atan2(xb - xa, -(yb - ya));
  const [dx, dy] = [Math.sin(r), -Math.cos(r)];
  const pointe = [
    [xb + dx * 13, yb + dy * 13],
    [xb - dy * 11, yb + dx * 11],
    [xb + dy * 11, yb - dx * 11],
  ];
  const id = `ev-cc${++numeroDessin}`;
  const m = TAILLE_SVG / 2;
  return `<svg viewBox="0 0 ${TAILLE_SVG} ${TAILLE_SVG}" aria-hidden="true"><defs><clipPath id="${id}"><circle cx="${m}" cy="${m}" r="${m - 1}"/></clipPath></defs><g clip-path="url(#${id})"><circle cx="${m}" cy="${m}" r="${m - 1}" fill="rgba(0,0,0,0.22)"/><g opacity="0.38" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">${fonds}</g><path d="${chemins(trace)}" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${pointe.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="#fff"/></g></svg>`;
}
