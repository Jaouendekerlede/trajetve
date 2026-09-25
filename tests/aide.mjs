// Outils communs aux tests : faux localStorage et faux réseau (aucun appel
// réel, donc des tests rapides, reproductibles et sans quota consommé).

export function installerLocalStorage() {
  const donnees = new Map();
  globalThis.localStorage = {
    getItem: (k) => (donnees.has(k) ? donnees.get(k) : null),
    setItem: (k, v) => donnees.set(k, String(v)),
    removeItem: (k) => donnees.delete(k),
    clear: () => donnees.clear(),
    key: (i) => [...donnees.keys()][i] ?? null,
    get length() {
      return donnees.size;
    },
  };
  return donnees;
}

// repondre(url, options) -> { statut, json } | { statut, texte } ; les
// appels sont gardés dans `appels` pour vérification.
export function installerFetch(repondre) {
  const appels = [];
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url: String(url), options });
    const r = await repondre(String(url), options);
    const statut = r.statut ?? 200;
    const corps = r.texte ?? JSON.stringify(r.json ?? {});
    return new Response(corps, { status: statut, headers: { "content-type": r.texte ? "text/plain" : "application/json" } });
  };
  return appels;
}

// Borne Open Charge Map minimale, au format de l'API.
export function poiOcm({ nom, lat, lon, kw = 150, operateur = "Réseau test", cout = null, statut = "Operational" }) {
  return {
    AddressInfo: { Title: nom, AddressLine1: "Aire de test", Town: "Ville", Latitude: lat, Longitude: lon },
    Connections: [{ ConnectionType: { Title: "CCS (Type 2)" }, PowerKW: kw, Quantity: 2, StatusType: { Title: "Operational" } }],
    OperatorInfo: { Title: operateur },
    StatusType: { Title: statut, IsOperational: true },
    NumberOfPoints: 2,
    UsageCost: cout,
    DateLastStatusUpdate: new Date().toISOString(),
    UsageType: { Title: "Public" },
  };
}
