// Sauvegarde et restauration de toutes les données (changement de téléphone).

import { toast, telechargerTexte } from "./ui-commun.js";
import { exporterDonnees, importerDonnees } from "./storage.js";

// Sauvegarde : partage du fichier (Drive, Gmail…) si le téléphone le
// permet, sinon téléchargement.
export async function exporterSauvegarde() {
  const texte = JSON.stringify(exporterDonnees(), null, 1);
  const nom = `trajetve-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  const fichier = new File([texte], nom, { type: "application/json" });
  if (navigator.canShare?.({ files: [fichier] })) {
    try {
      await navigator.share({ files: [fichier], title: "Sauvegarde Trajet VE" });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  telechargerTexte(nom, texte);
}

export async function importerSauvegarde(fichier) {
  try {
    const n = importerDonnees(JSON.parse(await fichier.text()));
    toast(`✅ Sauvegarde restaurée (${n} éléments) : redémarrage…`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(`⚠️ Import impossible : ${e.message}`);
  }
}
