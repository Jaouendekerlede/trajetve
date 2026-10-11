// Moyens de paiement de l'utilisateur (Menu › Payer aux bornes) et ce qu'ils
// permettent sur une borne donnée. Les bases de bornes ne disent pas quel
// badge passe où : seuls la carte bancaire (déclaration officielle), la
// gratuité et le réseau de la borne sont sûrs ; le badge reste « probable ».

export const RESEAUX_PAIEMENT = [
  { id: "ionity", nom: "Ionity", motif: /ionity/i },
  { id: "totalenergies", nom: "TotalEnergies", motif: /total\s*[eé]nergies/i },
  { id: "tesla", nom: "Tesla", motif: /tesla/i },
  { id: "electra", nom: "Electra", motif: /electra/i },
  { id: "fastned", nom: "Fastned", motif: /fastned/i },
  { id: "powerdot", nom: "Power Dot", motif: /power\s*dot/i },
  { id: "lidl", nom: "Lidl", motif: /lidl/i },
  { id: "vianeo", nom: "Engie Vianeo", motif: /vianeo/i },
  { id: "allego", nom: "Allego", motif: /allego/i },
  { id: "zunder", nom: "Zunder", motif: /zunder/i },
  { id: "atlante", nom: "Atlante", motif: /atlante/i },
  { id: "izivia", nom: "Izivia", motif: /izivia/i },
];

// Les 10 badges multi-réseaux les plus répandus en France (demande
// explicite de l'utilisateur le 2026-10-11). Ils fonctionnent tous à peu
// près partout grâce à l'interopérabilité imposée entre réseaux publics
// (GIREVE/Hubject) -- ce qui les différencie vraiment, c'est surtout le
// prix et l'abonnement, pas la compatibilité. On ne prétend donc pas
// connaître un détail réseau par réseau par badge : ce serait une fausse
// précision (les accords d'itinérance changent, invérifiable gratuitement).
// Seule exception sûre, déjà gérée séparément : les Superchargeurs Tesla
// (voir reseauDeLaBorne/facilitePaiement ci-dessous).
export const BADGES_MULTIRESEAUX = [
  { id: "chargemap", nom: "Chargemap Pass" },
  { id: "freshmile", nom: "Freshmile" },
  { id: "izivia_badge", nom: "Izivia" },
  { id: "shell", nom: "Shell Recharge" },
  { id: "totalenergies_badge", nom: "TotalEnergies Charge & Fuel" },
  { id: "kiwhi", nom: "KiWhi Pass" },
  { id: "plugsurfing", nom: "PlugSurfing" },
  { id: "mobilize", nom: "Mobilize Charge Pass" },
  { id: "bump", nom: "Bump" },
  { id: "driveco_badge", nom: "Driveco" },
];

// Par défaut : une carte bancaire sans contact, rien d'autre.
export function lireMoyens(reglages) {
  const m = reglages?.moyens_paiement || {};
  // badge_id : un des BADGES_MULTIRESEAUX, "autre" (badge non listé), ou "".
  // Ancien réglage booléen "badge: true" repris en "autre" pour ne pas
  // perdre le choix des utilisateurs déjà réglés avant cette version.
  const badgeId = typeof m.badge_id === "string" ? m.badge_id : m.badge === true ? "autre" : "";
  const badgeNom = BADGES_MULTIRESEAUX.find((b) => b.id === badgeId)?.nom || (badgeId ? "ton badge multi-réseaux" : "");
  return { cb: m.cb !== false, badge: !!badgeId, badgeId, badgeNom, reseaux: Array.isArray(m.reseaux) ? m.reseaux : [] };
}

export function reseauDeLaBorne(borne) {
  const o = borne.officiel && !borne.officiel.indisponible ? borne.officiel : null;
  const texte = [borne.operateur, o?.operateur, o?.enseigne, borne.nom_borne || borne.nom].filter(Boolean).join(" ");
  return RESEAUX_PAIEMENT.find((r) => r.motif.test(texte)) || null;
}

// Liste objective de ce qui fonctionne généralement ici, SANS tenir compte
// de ce que l'utilisateur possède (contrairement à facilitePaiement) --
// répond directement à "quelle carte/appli est acceptée sur cette borne ?"
// (ex: Ionity, Chargemap, Total...), demande explicite du 2026-10-09.
// [{ niveau: "sur" | "probable", texte }], jamais vide.
export function moyensAcceptesListe(borne) {
  const o = borne.officiel && !borne.officiel.indisponible ? borne.officiel : null;
  const reseau = reseauDeLaBorne(borne);
  const lignes = [];
  if (o?.gratuit === "oui") lignes.push({ niveau: "sur", texte: "Gratuit : aucun moyen de paiement nécessaire." });
  if (reseau) lignes.push({ niveau: "sur", texte: `Carte ou appli ${reseau.nom} (réseau propre à cette borne).` });
  if (o?.paiement_cb === "oui") lignes.push({ niveau: "sur", texte: "Carte bancaire sans contact." });
  else if (o?.paiement_cb === "partiel") lignes.push({ niveau: "probable", texte: "Carte bancaire sur une partie des points seulement." });
  else if (!o && borne.paiement_cb_probable) lignes.push({ niveau: "probable", texte: "Carte bancaire probable (non confirmé par une source officielle)." });
  // Les Superchargeurs Tesla ne prennent pas les badges externes.
  if (reseau?.id !== "tesla") lignes.push({ niveau: "probable", texte: "Badge multi-réseaux (Chargemap Pass, Freshmile, Shell Recharge…)." });
  if (!lignes.length) {
    lignes.push({
      niveau: "probable",
      texte: reseau ? `Carte/appli ${reseau.nom}, ou badge multi-réseaux -- à vérifier sur place.` : "Non confirmé : prévois l'appli du réseau ou le QR code affiché sur la borne.",
    });
  }
  return lignes;
}

// { niveau: "sur" | "probable" | "incertain", texte }
export function facilitePaiement(borne, moyens) {
  const o = borne.officiel && !borne.officiel.indisponible ? borne.officiel : null;
  const reseau = reseauDeLaBorne(borne);
  if (o?.gratuit === "oui") return { niveau: "sur", texte: "Recharge gratuite : rien à payer." };
  if (reseau && moyens.reseaux.includes(reseau.id)) return { niveau: "sur", texte: `Ton appli ${reseau.nom} fonctionne ici.` };
  if (moyens.cb && o?.paiement_cb === "oui") return { niveau: "sur", texte: "Ta carte bancaire est acceptée." };
  if (moyens.cb && o?.paiement_cb === "partiel") return { niveau: "probable", texte: "Carte bancaire acceptée sur une partie des points seulement." };
  // Les Superchargeurs Tesla ne prennent pas les badges : appli Tesla seulement.
  if (moyens.badge && reseau?.id !== "tesla") return { niveau: "probable", texte: `Ton ${moyens.badgeNom} devrait passer ici : vérifie-le dans son appli.` };
  if (moyens.cb && !o && borne.paiement_cb_probable) return { niveau: "probable", texte: "Carte bancaire probablement acceptée (non confirmé)." };
  return {
    niveau: "incertain",
    texte: reseau ? `Aucun de tes moyens n'est confirmé ici : prévois l'appli ${reseau.nom}.` : "Aucun de tes moyens n'est confirmé ici : prévois l'appli du réseau ou le QR code de la borne.",
  };
}
