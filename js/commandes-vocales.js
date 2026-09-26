// Commandes vocales (reconnaissance vocale du navigateur, en français) :
// « prochaine borne ? », « coupe le son », « trouve une boulangerie »,
// « aller à Nantes »…

export function reconnaissanceDispo() {
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Écoute une phrase ; renvoie le texte reconnu, ou null.
export function ecouter() {
  return new Promise((resolve) => {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return resolve(null);
    const r = new R();
    r.lang = "fr-FR";
    r.interimResults = false;
    r.maxAlternatives = 1;
    let fini = false;
    const finir = (texte) => {
      if (fini) return;
      fini = true;
      resolve(texte);
    };
    r.onresult = (e) => finir(e.results?.[0]?.[0]?.transcript || null);
    r.onerror = () => finir(null);
    r.onend = () => finir(null);
    try {
      r.start();
    } catch {
      finir(null);
    }
  });
}

const RECHERCHES = [
  [/caf[ée]/, "café"],
  [/boulang|pain|croissant/, "boulangerie"],
  [/restau|manger|d[ée]jeuner|d[îi]ner/, "restaurant"],
  [/supermarch|courses|magasin/, "supermarché"],
  [/toilette|wc|pipi/, "toilettes"],
  [/lavage|laver la voiture/, "lavage auto"],
];

// Texte reconnu → { action, ... }. Actions : voix (valeur), barree, hud,
// partage, parkings, batterie, arrivee, borne, recherche (requete), aller
// (lieu), inconnu.
export function interpreterCommande(texte) {
  const t = String(texte || "").toLowerCase().replace(/[’']/g, "'").trim();
  if (!t) return { action: "inconnu" };
  if (/(coupe|couper|silence|tais[- ]toi|muet|arr[êe]te de parler)/.test(t)) return { action: "voix", valeur: false };
  if (/(remet|active|rallume|r[ée]active).*(son|voix)/.test(t)) return { action: "voix", valeur: true };
  if (/(route|rue|c'est) (est )?(barr[ée]|coup[ée]|ferm[ée])/.test(t)) return { action: "barree" };
  if (/(t[êe]te haute|hud|pare-brise)/.test(t)) return { action: "hud" };
  if (/(partag|envoi|pr[ée]vien)/.test(t)) return { action: "partage" };
  if (/(parking|garer|stationner)/.test(t)) return { action: "parkings" };
  for (const [motif, requete] of RECHERCHES) if (motif.test(t)) return { action: "recherche", requete };
  if (/(batterie|autonomie|pourcentage)/.test(t)) return { action: "batterie" };
  if (/(prochaine borne|borne|recharge)/.test(t)) return { action: "borne" };
  if (/(heure d'arriv|quand .*arriv|combien de temps|temps restant|on arrive)/.test(t)) return { action: "arrivee" };
  if (/(maison|chez moi|domicile)/.test(t)) return { action: "aller", lieu: "Chez moi" };
  const m = /^(?:aller|va|allons|emm[eè]ne[- ]moi|conduis[- ]moi|direction|trajet|itin[ée]raire|je veux aller|guide[- ]moi)\s+(?:à|a|au|aux|vers|jusqu'à|jusqu'au|pour|en)?\s*(.+)$/.exec(t);
  if (m) return { action: "aller", lieu: m[1].charAt(0).toUpperCase() + m[1].slice(1) };
  return { action: "inconnu", texte: t };
}
