import { initialiserUI } from "./ui.js";

initialiserUI();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) => {
      console.warn("[SW] Enregistrement échoué", e);
    });
  });
}
