// Sauvegarde sur Google Drive (compte gratuit suffisant) : un seul fichier
// dans le dossier caché réservé à l'appli (« appDataFolder ») : l'appli ne
// voit pas les autres fichiers du Drive, et ils ne voient pas celui-ci.
// Connexion Google par « Google Identity Services » : l'identifiant client
// (public, créé une fois dans la console Google Cloud) est dans le Profil.

const PORTEE = "https://www.googleapis.com/auth/drive.appdata";
const NOM_FICHIER = "trajetve-sauvegarde.json";
const API = "https://www.googleapis.com/drive/v3/files";
const API_ENVOI = "https://www.googleapis.com/upload/drive/v3/files";

let chargementGis = null;
let jeton = null; // { valeur, expire }

function chargerGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  chargementGis ??= new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => ok();
    s.onerror = () => {
      chargementGis = null;
      ko(new Error("service de connexion Google injoignable (réseau ?)"));
    };
    document.head.appendChild(s);
  });
  return chargementGis;
}

// Jeton d'accès (1 h). À appeler depuis un appui de l'utilisateur : Google
// peut ouvrir une petite fenêtre de connexion.
export async function obtenirJeton(clientId, { silencieux = false } = {}) {
  if (jeton && jeton.expire > Date.now() + 60000) return jeton.valeur;
  if (!clientId) throw new Error("identifiant client Google manquant (Profil › Sauvegarde)");
  await chargerGis();
  return new Promise((ok, ko) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: PORTEE,
      callback: (r) => {
        if (r.error) return ko(new Error(r.error_description || r.error));
        jeton = { valeur: r.access_token, expire: Date.now() + (r.expires_in || 3600) * 1000 };
        ok(jeton.valeur);
      },
      error_callback: (e) => ko(new Error(e?.message || e?.type || "connexion refusée")),
    });
    client.requestAccessToken({ prompt: silencieux ? "" : "consent" });
  });
}

async function appel(url, jetonAcces, options = {}) {
  const r = await fetch(url, { ...options, headers: { Authorization: `Bearer ${jetonAcces}`, ...(options.headers || {}) } });
  if (!r.ok) throw new Error(`Drive : HTTP ${r.status}`);
  return r;
}

export async function trouverSauvegarde(jetonAcces) {
  const q = encodeURIComponent(`name='${NOM_FICHIER}'`);
  const r = await appel(`${API}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime,size)&orderBy=modifiedTime desc`, jetonAcces);
  return (await r.json()).files?.[0] || null;
}

// Envoie (ou remplace) la sauvegarde. Renvoie { id, modifiedTime }.
export async function envoyerSauvegarde(jetonAcces, sauvegarde) {
  const contenu = JSON.stringify(sauvegarde);
  const existant = await trouverSauvegarde(jetonAcces);
  if (existant) {
    const r = await appel(`${API_ENVOI}/${existant.id}?uploadType=media&fields=id,modifiedTime`, jetonAcces, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: contenu });
    return r.json();
  }
  const limite = "trajetve" + Math.random().toString(36).slice(2);
  const corps = `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: NOM_FICHIER, parents: ["appDataFolder"] })}\r\n--${limite}\r\nContent-Type: application/json\r\n\r\n${contenu}\r\n--${limite}--`;
  const r = await appel(`${API_ENVOI}?uploadType=multipart&fields=id,modifiedTime`, jetonAcces, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${limite}` }, body: corps });
  return r.json();
}

// Dernière sauvegarde (objet) ou null.
export async function lireSauvegarde(jetonAcces) {
  const f = await trouverSauvegarde(jetonAcces);
  if (!f) return null;
  const r = await appel(`${API}/${f.id}?alt=media`, jetonAcces);
  return { sauvegarde: await r.json(), date: f.modifiedTime };
}

// Pour les tests.
export function oublierJeton() {
  jeton = null;
}
