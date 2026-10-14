// Chargement à la demande d'une bibliothèque (js/vendor/), une seule fois.
// Même principe que Vallet et MeteoAI (Leaflet).

const chargees = {};

export function chargerScript(src) {
  chargees[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => {
      delete chargees[src];
      reject(new Error("bibliothèque introuvable (hors-ligne ?)"));
    };
    document.head.appendChild(s);
  });
  return chargees[src];
}
