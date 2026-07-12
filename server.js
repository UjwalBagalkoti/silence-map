require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const USER_AGENT = 'SilenceMap/1.0 (github.com/UjwalBagalkoti/silence-map)';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * GET /api/geocode?q=<place name>
 * Turns a place name into coordinates using Nominatim (OpenStreetMap).
 * Free, no API key required.
 */
app.get('/api/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query parameter "q".' });

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!r.ok) throw new Error(`Nominatim responded with ${r.status}`);
    const data = await r.json();
    res.json(data.map(d => ({
      display_name: d.display_name,
      lat: parseFloat(d.lat),
      lon: parseFloat(d.lon)
    })));
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the geocoding service.', detail: err.message });
  }
});

/**
 * GET /api/silence-map?lat=<n>&lon=<n>&radius=<meters, optional>
 *
 * Finds named points of interest near a coordinate via the Overpass API
 * (OpenStreetMap), then scores each one by how little is documented about
 * it: fewer OSM tags (no website, no wiki link, no opening hours, no
 * cuisine, etc.) means a higher "silence score". This is the app's core
 * idea — absence of data as the signal, instead of presence of data.
 */
app.get('/api/silence-map', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = Math.min(parseInt(req.query.radius, 10) || 2000, 5000);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: 'Query parameters "lat" and "lon" are required numbers.' });
  }

  const query = `
    [out:json][timeout:25];
    (
      node["name"]["amenity"](around:${radius},${lat},${lon});
      node["name"]["shop"](around:${radius},${lat},${lon});
      node["name"]["tourism"](around:${radius},${lat},${lon});
      node["name"]["leisure"](around:${radius},${lat},${lon});
    );
    out body;
  `;

  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
      body: query
    });
    if (!r.ok) throw new Error(`Overpass responded with ${r.status}`);
    const data = await r.json();

    const places = (data.elements || [])
      .filter(el => el.tags && el.tags.name && el.lat && el.lon)
      .map(el => {
        const tagCount = Object.keys(el.tags).length;
        // Most POIs have at least 2 tags (name + a category). Every tag
        // beyond that — website, phone, opening_hours, cuisine, wikidata,
        // wheelchair access, etc. — means more has been recorded about the
        // place, so it lowers the silence score.
        const silenceScore = Math.max(0, Math.min(100, Math.round(100 - (tagCount - 2) * 11)));
        return {
          id: el.id,
          name: el.tags.name,
          category: el.tags.amenity || el.tags.shop || el.tags.tourism || el.tags.leisure || 'place',
          lat: el.lat,
          lon: el.lon,
          tag_count: tagCount,
          silence_score: silenceScore,
          has_website: Boolean(el.tags.website || el.tags['contact:website']),
          has_wikipedia: Boolean(el.tags.wikipedia || el.tags.wikidata)
        };
      })
      .sort((a, b) => b.silence_score - a.silence_score || a.tag_count - b.tag_count)
      .slice(0, 40);

    res.json({ count: places.length, radius, center: { lat, lon }, places });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the map data service.', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Silence Map running at http://localhost:${PORT}`);
});
