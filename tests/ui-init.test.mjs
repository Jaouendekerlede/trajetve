// Fumée : démarre réellement l'appli (initialiserUI) dans un DOM simulé
// (jsdom), au lieu de ne relire que du code. Deux bugs réels de cette
// session n'auraient été repérés qu'ici : un bouton supprimé mais encore
// référencé (plantait initialiserUI avant même de câbler le formulaire de
// trajet) et une barre de jauge invisible (display:inline par défaut sur
// un <span>, jamais vu par les tests de logique pure). Volontairement
// minimal : on vérifie que l'appli démarre et que ses pièces maîtresses
// sont bien câblées, pas le détail de chaque écran.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { JSDOM } from "jsdom";

const html = readFileSync("index.html", "utf8");
const css = readFileSync("style.css", "utf8");

function fauxChainable() {
  const cible = () => fauxChainable();
  return new Proxy(cible, {
    get(_t, prop) {
      if (prop === "lat" || prop === "lng" || prop === "x" || prop === "y") return 0;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined; // pas une promesse
      return fauxChainable();
    },
    apply() {
      return fauxChainable();
    },
    construct() {
      return fauxChainable();
    },
  });
}

async function demarrerAppli() {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`, {
    url: "https://example.com/",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.history = window.history;
  // jsdom n'implémente pas matchMedia : mock minimal (jamais "sombre" par
  // préférence système, pas d'évènement de changement nécessaire ici).
  const matchMediaFaux = (requete) => ({
    matches: false,
    media: requete,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.matchMedia = matchMediaFaux;
  global.matchMedia = matchMediaFaux;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  global.FormData = window.FormData;
  global.File = window.File;
  global.Blob = window.Blob;
  global.URL = window.URL;
  global.HTMLElement = window.HTMLElement;
  global.CustomEvent = window.CustomEvent;
  global.Event = window.Event;
  Object.defineProperty(global, "navigator", { value: window.navigator, configurable: true });
  window.localStorage.clear();

  // Leaflet (L) : jamais chargé en jsdom (les <script> ne s'exécutent
  // pas) -- mock permissif, seule la présence des méthodes importe ici,
  // pas leur comportement cartographique réel.
  global.L = fauxChainable();
  window.L = global.L;

  global.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });

  const ui = await import(`../js/ui.js?t=${Date.now()}`);
  ui.initialiserUI();
  return { dom, ui };
}

test("initialiserUI() démarre sans exception et câble l'écran principal", async () => {
  const { dom } = await demarrerAppli();
  const { document } = dom.window;
  // Écran par défaut affiché, pas resté masqué par une exception en cours
  // de câblage (c'est exactement ce que le bug du bouton supprimé cassait).
  assert.ok(!document.getElementById("vue-bornes").classList.contains("hidden"), "l'écran Carte doit être visible au démarrage");
  // Le formulaire de trajet doit être câblé (preuve que cablerFormulaire()
  // a bien été atteint, pas interrompu par une exception plus tôt dans
  // initialiserUI()).
  const bouton = document.getElementById("ev-relais-batterie-btn");
  assert.ok(bouton, "le bouton de récupération batterie doit exister");
  assert.doesNotThrow(() => bouton.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
});

test("barre de charge (fiche véhicule) : le remplissage est bien visible (display:block)", async () => {
  const { dom } = await demarrerAppli();
  const { document, getComputedStyle } = dom.window;
  const fill = document.getElementById("ev-fiche-vehicule-jauge-fill");
  const track = fill.parentElement;
  // Régression du 2026-10-26 : un <span> sans display:block explicite
  // ignore sa largeur/hauteur CSS -- le remplissage devenait invisible
  // bien que le JS fixe sa couleur et son pourcentage correctement.
  assert.equal(getComputedStyle(track).display, "block", "la piste de la jauge doit être en display:block");
  assert.equal(getComputedStyle(fill).display, "block", "le remplissage de la jauge doit être en display:block");
});

test("écran Mes statistiques : s'ouvre sans exception via le menu", async () => {
  const { dom } = await demarrerAppli();
  const { document, Event } = dom.window;
  const lienMenu = document.querySelector('.ev-menu-ligne[data-bloc="ev-bloc-stats"]');
  assert.ok(lienMenu, "le lien de menu vers Mes statistiques doit exister");
  assert.doesNotThrow(() => lienMenu.dispatchEvent(new Event("click", { bubbles: true })));
  assert.ok(!document.getElementById("vue-outils").classList.contains("hidden"), "l'écran Outils doit s'afficher après le clic");
});
