const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Static files, MA senza index.html automatico su "/"
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Home: sempre kiosk.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kiosk.html"));
});

/**
 * =========================
 * CONFIG AREA (MODIFICA QUI SE SERVE)
 * =========================
 */
const BBOX = {
  // esempio: LINATE / Milano
  lamin: 45.38,
  lomin: 9.15,
  lamax: 45.55,
  lomax: 9.35,
};

// OpenSky (fetch nativo in Node 18+)
app.get("/api/planes", async (req, res) => {
  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${BBOX.lamin}&lomin=${BBOX.lomin}&lamax=${BBOX.lamax}&lomax=${BBOX.lomax}`;

    const r = await fetch(url, { headers: { "User-Agent": "plane-zone" } });
    if (!r.ok) return res.status(500).json({ error: "OpenSky error", status: r.status });

    const data = await r.json();
    if (!data.states) return res.json([]);

    const planes = data.states
      .map(s => ({
        icao24: s[0],
        callsign: s[1]?.trim(),
        lon: s[5],
        lat: s[6],
        altitude: s[7],
        velocity: s[9],
        heading: s[10],
      }))
      .filter(p => p.callsign && p.lat != null && p.lon != null);

    res.json(planes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✈️ Server attivo su http://localhost:${PORT}`);
});
