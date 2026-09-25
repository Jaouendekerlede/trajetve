import { initialiserUI } from "./ui.js";
import { navigationActive } from "./navigation.js";

initialiserUI();

const VERIFICATION_MAJ_MS = 30 * 60 * 1000;

// Nouvelle version installée en arrière-plan : on propose de recharger,
// jamais pendant une navigation (le rechargement la couperait).
function proposerMiseAJour() {
  if (navigationActive()) {
    setTimeout(proposerMiseAJour, 60000);
    return;
  }
  if (document.getElementById("ev-maj")) return;
  const bandeau = document.createElement("div");
  bandeau.id = "ev-maj";
  bandeau.className = "ev-maj";
  bandeau.innerHTML = `<span>✨ Nouvelle version de l'appli disponible</span><button type="button" class="ev-btn">Mettre à jour</button>`;
  bandeau.querySelector("button").addEventListener("click", () => location.reload());
  document.body.appendChild(bandeau);
}

if ("serviceWorker" in navigator) {
  // Au tout premier lancement, l'installation n'est pas une « mise à jour ».
  const avaitUneVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (avaitUneVersion) proposerMiseAJour();
  });
  window.addEventListener("load", async () => {
    try {
      const inscription = await navigator.serviceWorker.register("./service-worker.js");
      const verifier = () => inscription.update().catch(() => {});
      setInterval(verifier, VERIFICATION_MAJ_MS);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && verifier());
    } catch (e) {
      console.warn("[SW] Enregistrement échoué", e);
    }
  });
}
