// Scan d'un QR code (borne de recharge) avec la caméra. Deux moteurs,
// gratuits et sans serveur -- même principe que Vallet :
//  - le BarcodeDetector natif (Chrome Android, dont le Pixel) : rapide, rien
//    à télécharger ;
//  - sinon ZXing (js/vendor/, ~330 Ko, chargé seulement au premier scan) pour
//    iPhone, Chrome Windows, etc.
// Contrairement à Vallet, on n'a besoin que de la valeur décodée (l'URL du
// réseau de recharge) -- pas de redessiner le code ensuite.

import { chargerScript } from "./chargeur.js";

export function disponible() {
  return !!navigator.mediaDevices?.getUserMedia;
}

async function scannerNatif(video, signal) {
  const detecteur = new window.BarcodeDetector();
  const flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  video.srcObject = flux;
  await video.play();
  try {
    while (!signal.aborted) {
      const trouves = await detecteur.detect(video).catch(() => []);
      if (trouves.length) return { valeur: trouves[0].rawValue };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("scan annulé");
  } finally {
    flux.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

async function scannerZxing(video, signal) {
  await chargerScript("js/vendor/zxing-library.min.js");
  const lecteur = new window.ZXing.BrowserMultiFormatReader();
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      lecteur.reset();
      reject(new Error("scan annulé"));
    });
    lecteur
      .decodeFromConstraints({ video: { facingMode: "environment" }, audio: false }, video, (resultat) => {
        if (!resultat) return;
        lecteur.reset();
        resolve({ valeur: resultat.getText() });
      })
      .catch((e) => {
        lecteur.reset();
        reject(e);
      });
  });
}

// Ouvre la caméra dans `video` jusqu'à lire un code. Renvoie { valeur } (le
// texte décodé, en général l'URL du réseau de recharge) ou lève une erreur.
// `signal` (AbortSignal) permet d'annuler.
export function scanner(video, signal) {
  return "BarcodeDetector" in window ? scannerNatif(video, signal) : scannerZxing(video, signal);
}
