const express = require("express");
const path = require("path");


// --- Linate airline mapping (override ADSBdb when needed)
const LINATE_AIRLINES = {"AZ": "ITA Airways", "EI": "Aer Lingus", "XZ": "AeroItalia", "EN": "Air Dolomiti", "AF": "Air France", "OS": "Austrian Airlines", "BA": "British Airways", "SN": "Brussels Airlines", "DX": "DAT", "U2": "easyJet", "AY": "Finnair", "IB": "Iberia", "KL": "KLM", "KM": "KM Malta Airlines", "LH": "Lufthansa", "LG": "Luxair", "SK": "Scandinavian Airlines", "PI": "Small Fly Airlines", "V7": "Volotea"};
function overrideAirlineName(enrich) {
  if (!enrich) return enrich;
  const cs = (enrich.callsign_iata || '').toUpperCase();
  const code = cs.slice(0, 2);
  if (code && LINATE_AIRLINES[code]) enrich.airline_name = LINATE_AIRLINES[code];
  return enrich;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Static files (senza index.html automatico su "/")
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Home -> kiosk.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kiosk.html"));
});

/**
 * =========================
 * CONFIG BBOX (MODIFICA QUI)
 * =========================
 * JFK area (esempio)
 */
const BBOX = {
  lamin: 45.46,
  lomin: 9.23,
  lamax: 45.58,
  lomax: 9.43,
};

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, stop: () => clearTimeout(t) };
}

/**
 * ADSBdb (callsign) -> flightroute + airline + aeroporti
 */
async function enrichFromADSBDB(callsignRaw) {
  const callsign = (callsignRaw || "").trim();
  if (!callsign) return null;

  const url = `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`;
  const t = withTimeout(2500);

  try {
    const r = await fetch(url, {
      signal: t.signal,
      headers: { "User-Agent": "plane-zone" },
    });
    if (!r.ok) return null;

    const j = await r.json();
    const fr = j?.response?.flightroute;
    if (!fr) return null;

    return {
      callsign_iata: fr.callsign_iata || null,
      airline_name: fr.airline?.name || null,

      from: fr.origin
        ? {
            municipality: fr.origin.municipality || null,
            name: fr.origin.name || null,
            iata: fr.origin.iata_code || fr.origin.iata || null,
          }
        : null,

      to: fr.destination
        ? {
            municipality: fr.destination.municipality || null,
            name: fr.destination.name || null,
            iata: fr.destination.iata_code || fr.destination.iata || null,
          }
        : null,
    };
  } catch {
    return null;
  } finally {
    t.stop();
  }
}

/**
 * hexdb.io (icao24/hex) -> tipo aereo generico (A320/B738/...)
 * Endpoint: https://hexdb.io/api/v1/aircraft/{hex}
 */
async function enrichAircraftFromHexDB(icao24) {
  const hex = (icao24 || "").trim().toLowerCase();
  if (!hex) return null;

  const url = `https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`;
  const t = withTimeout(2500);

  try {
    const r = await fetch(url, {
      signal: t.signal,
      headers: { "User-Agent": "plane-zone" },
    });
    if (!r.ok) return null;

    const j = await r.json();
    if (j?.status === "404") return null;

    // esempio risposta: {"ICAOTypeCode":"A319", ...}
    const typeCode = j?.ICAOTypeCode || null;
    return typeCode ? { aircraft_model: typeCode } : null;
  } catch {
    return null;
  } finally {
    t.stop();
  }
}

/**
 * API /api/planes
 * - prende OpenSky states
 * - arricchisce i primi N con ADSBdb + hexdb (gratis)
 */
app.get("/api/planes", async (req, res) => {
  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${BBOX.lamin}&lomin=${BBOX.lomin}&lamax=${BBOX.lamax}&lomax=${BBOX.lomax}`;
    const r = await fetch(url, { headers: { "User-Agent": "plane-zone" } });
    if (!r.ok) return res.status(500).json({ error: "OpenSky error", status: r.status });

    const data = await r.json();
    const states = data.states || [];

    let planes = states
      .map((s) => ({
        icao24: s[0],
        callsign: s[1]?.trim() || null,
        lon: s[5],
        lat: s[6],
        altitude: s[7],
        velocity: s[9],
        heading: s[10],
      }))
      .filter((p) => p.callsign);

    // Non martelliamo i provider: arricchiamo solo i primi 8
    const limit = Math.min(8, planes.length);

    for (let i = 0; i < limit; i++) {
      // ADSBdb + hexdb in parallelo
      const [routeEnrich, aircraftEnrich] = await Promise.all([
        enrichFromADSBDB(planes[i].callsign),
        enrichAircraftFromHexDB(planes[i].icao24),
      ]);

      if (routeEnrich) planes[i] = { ...planes[i], ...overrideAirlineName(routeEnrich) };
      // modello: se hexdb lo trova, lo mettiamo (anche se ADSBdb non lo ha)
      if (aircraftEnrich) planes[i] = { ...planes[i], ...aircraftEnrich };
    }

    res.json(planes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✈️ Server attivo su http://localhost:${PORT}`);
});
