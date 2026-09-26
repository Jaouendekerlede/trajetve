import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installerFetch } from "./aide.mjs";
import { envoyerSauvegarde, lireSauvegarde } from "../js/drive.js";

const sauvegarde = { format: "trajetve-sauvegarde", donnees: { trajetve_reglages: "{}" } };
let fichiers;
beforeEach(() => (fichiers = []));

test("Drive : première sauvegarde créée dans le dossier caché de l'appli, puis remplacée", async () => {
  const appels = installerFetch((url, o) => {
    if (url.includes("/drive/v3/files?spaces=appDataFolder")) return { json: { files: fichiers } };
    if (url.includes("uploadType=multipart")) {
      fichiers.push({ id: "F1", modifiedTime: "2026-09-26T10:00:00Z" });
      return { json: { id: "F1" } };
    }
    if (url.includes("/upload/drive/v3/files/F1")) return { json: { id: "F1" } };
    return { statut: 404, texte: "?" };
  });
  await envoyerSauvegarde("JETON", sauvegarde);
  const creation = appels.find((a) => a.url.includes("multipart"));
  assert.equal(creation.options.headers.Authorization, "Bearer JETON");
  assert.ok(creation.options.body.includes('"parents":["appDataFolder"]'));
  await envoyerSauvegarde("JETON", sauvegarde);
  assert.equal(appels.filter((a) => a.url.includes("multipart")).length, 1, "remplacée, pas dupliquée");
  assert.equal(appels.find((a) => a.url.includes("/files/F1?uploadType=media")).options.method, "PATCH");
});

test("Drive : restauration de la dernière sauvegarde (ou rien)", async () => {
  installerFetch((url) => (url.includes("alt=media") ? { json: sauvegarde } : { json: { files: fichiers } }));
  assert.equal(await lireSauvegarde("JETON"), null);
  fichiers.push({ id: "F1", modifiedTime: "2026-09-26T10:00:00Z" });
  const r = await lireSauvegarde("JETON");
  assert.equal(r.sauvegarde.format, "trajetve-sauvegarde");
  assert.equal(r.date, "2026-09-26T10:00:00Z");
});

test("Drive : une erreur de Google est rapportée avec son message", async () => {
  installerFetch((url) => (url.includes("spaces=appDataFolder") ? { statut: 400, json: { error: { code: 400, message: "Invalid value for: orderBy" } } } : { json: {} }));
  await assert.rejects(envoyerSauvegarde("JETON", sauvegarde), /HTTP 400 : Invalid value for: orderBy/);
});
