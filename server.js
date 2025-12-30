const express = require("express");

const app = express();
const PORT = 3000;

// JFK bbox (se vuoi cambiarlo, modifica qui)
const BBOX = { lamin: 45.45, lomin: 9.20, lamax: 45.60, lomax: 9.45 };

// cache callsign -> flightroute
const routeCache = new Map();
const ROUTE_TTL = 10 * 60 * 1000;

// cache icao24 -> aircraft
const aircraftCache = new Map();
const AIRCRAFT_TTL = 24 * 60 * 60 * 1000;

// cache wiki query -> photo url
const wikiCache = new Map();
const WIKI_TTL = 30 * 24 * 60 * 60 * 1000;

function normCallsign(cs) {
  return cs ? String(cs).trim().toUpperCase() : "";
}

function simplifyModelName(s) {
  if (!s) return null;
  let x = String(s).trim();

  // rimuovi cose tra parentesi e dopo trattini (es: "Airbus A321-231" -> "Airbus A321")
  x = x.replace(/\(.*?\)/g, "").trim();
  x = x.replace(/[-–].*$/g, "").trim();

  // se è rimasto troppo lungo, prova a tenere solo i primi 2-3 token
  const parts = x.split(/\s+/).filter(Boolean);
  if (parts.length > 3) x = parts.slice(0, 3).join(" ");

  return x;
}

// --- ADSBDB: flightroute ---
async function adsbdbFlightRoute(callsign) {
  const cs = normCallsign(callsign);
  if (!cs) return null;

  const c = routeCache.get(cs);
  if (c && c.exp > Date.now()) return c.data;

  const url = `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "plane-zone/1.0 (local)", "Accept": "application/json" }
  });
  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  const fr = j?.response?.flightroute ?? null;

  routeCache.set(cs, { data: fr, exp: Date.now() + ROUTE_TTL });
  return fr;
}

// --- HEXDB: aircraft model/type ---
async function hexdbAircraft(icao24) {
  if (!icao24) return null;

  const hex = icao24.toLowerCase();
  const c = aircraftCache.get(hex);
  if (c && c.exp > Date.now()) return c.data;

  const url = `https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "plane-zone/1.0 (local)", "Accept": "application/json" }
  });
  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  if (!j || j.error) return null;

  const data = {
    type: j.Type || null,
    model: j.Model || null,
  };

  aircraftCache.set(hex, { data, exp: Date.now() + AIRCRAFT_TTL });
  return data;
}

// --- WIKIPEDIA: thumbnail automatica via search + summary ---
async function wikiThumbnailForModel(modelText) {
  const q = simplifyModelName(modelText);
  if (!q) return null;

  const cached = wikiCache.get(q);
  if (cached && cached.exp > Date.now()) return cached.url;

  try {
    // 1) cerca titolo
    const searchUrl =
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&namespace=0&format=json`;

    const sr = await fetch(searchUrl, {
      headers: { "User-Agent": "plane-zone/1.0 (local)", "Accept": "application/json" }
    });
    if (!sr.ok) {
      wikiCache.set(q, { url: null, exp: Date.now() + WIKI_TTL });
      return null;
    }

    const sj = await sr.json().catch(() => null);
    const title = sj?.[1]?.[0] || null;
    if (!title) {
      wikiCache.set(q, { url: null, exp: Date.now() + WIKI_TTL });
      return null;
    }

    // 2) prendi thumbnail dal summary
    const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const rr = await fetch(sumUrl, {
      headers: { "User-Agent": "plane-zone/1.0 (local)", "Accept": "application/json" }
    });
    if (!rr.ok) {
      wikiCache.set(q, { url: null, exp: Date.now() + WIKI_TTL });
      return null;
    }

    const rj = await rr.json().catch(() => null);
    const thumb = rj?.thumbnail?.source || null;

    wikiCache.set(q, { url: thumb, exp: Date.now() + WIKI_TTL });
    return thumb;
  } catch {
    wikiCache.set(q, { url: null, exp: Date.now() + WIKI_TTL });
    return null;
  }
}

app.use(express.static("public"));

app.get("/api/planes", async (_req, res) => {
  const osUrl =
    `https://opensky-network.org/api/states/all` +
    `?lamin=${BBOX.lamin}&lomin=${BBOX.lomin}` +
    `&lamax=${BBOX.lamax}&lomax=${BBOX.lomax}`;

  const osRes = await fetch(osUrl);
  const osJson = await osRes.json().catch(() => ({}));
  const states = osJson.states || [];

  const planes = states
    .map(s => ({
      icao24: s[0] || null,
      callsign: normCallsign(s[1]),
      lat: s[6] ?? null,
      lon: s[5] ?? null,
    }))
    .filter(p => p.lat != null && p.lon != null);

  // flightroute per callsign unici
  const uniqueCallsigns = [...new Set(planes.map(p => p.callsign).filter(Boolean))];
  const routeEntries = await Promise.all(
    uniqueCallsigns.map(async cs => [cs, await adsbdbFlightRoute(cs)])
  );
  const routeByCs = new Map(routeEntries);

  // aircraft info per hex unici
  const uniqueHex = [...new Set(planes.map(p => p.icao24).filter(Boolean))];
  const aircraftEntries = await Promise.all(
    uniqueHex.map(async hex => [hex, await hexdbAircraft(hex)])
  );
  const aircraftByHex = new Map(aircraftEntries);

  // wikipedia photo per modello (unici)
  const uniqueModelKeys = [
    ...new Set(uniqueHex.map(h => aircraftByHex.get(h)?.model || aircraftByHex.get(h)?.type).filter(Boolean))
  ];
  const wikiEntries = await Promise.all(
    uniqueModelKeys.map(async mk => [mk, await wikiThumbnailForModel(mk)])
  );
  const photoByModel = new Map(wikiEntries);

  const out = planes.map(p => {
    const fr = p.callsign ? routeByCs.get(p.callsign) : null;
    const ac = p.icao24 ? aircraftByHex.get(p.icao24) : null;

    const modelKey = ac?.model || ac?.type || null;
    const photo = modelKey ? (photoByModel.get(modelKey) || null) : null;

    return {
      icao24: p.icao24,
      callsign: p.callsign,

      callsign_iata: fr?.callsign_iata || null,
      airline_name: fr?.airline?.name || null,

      from: fr?.origin ? { municipality: fr.origin.municipality, name: fr.origin.name } : null,
      to: fr?.destination ? { municipality: fr.destination.municipality, name: fr.destination.name } : null,

      aircraft_type: ac?.type || null,
      aircraft_model: ac?.model || null,

      aircraft_photo: photo, // <-- Wikipedia thumbnail
    };
  });

  res.json(out);
});

app.listen(PORT, () => console.log(`✈️ Server attivo su http://localhost:${PORT}`));
