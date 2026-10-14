// Copie les fichiers web de l'appli (sans node_modules/src-tauri/tests/.git)
// dans dist-tauri/, pour que Tauri puisse les embarquer dans l'APK Android.
// L'appli web elle-même (servie normalement en statique) n'est jamais déplacée.
import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..");
const cible = join(racine, "dist-tauri");

const FICHIERS = ["index.html", "style.css", "manifest.json", "service-worker.js", "actualiser.html", "suivi.html"];
const DOSSIERS = ["icons", "js"];

if (existsSync(cible)) rmSync(cible, { recursive: true, force: true });
mkdirSync(cible, { recursive: true });

for (const f of FICHIERS) cpSync(join(racine, f), join(cible, f));
for (const d of DOSSIERS) cpSync(join(racine, d), join(cible, d), { recursive: true });

console.log(`dist-tauri prêt (${FICHIERS.length} fichiers, ${DOSSIERS.length} dossiers)`);
