require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const USER_AGENT = 'SilenceMap/1.1 (github.com/UjwalBagalkoti/silence-map)';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const ALL_GROUPS = ['amenity', 'shop', 'tourism', 'leisure'];
const MAX_RESULTS = 60;
const CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_TTL_MS = 60 * 60 * 1000;

app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------- helpers

/** Tiny in-memory TTL cache so repeated searches don't hammer free public APIs. */
function makeCache(ttl, maxEntries = 300) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.t > ttl) { store.delete(key); return undefined; }
      return hit.v;
    },
    set(key, v) {
      if (store.size >= maxEntries) store.delete(store.keys().next().value);
      store.set(key, { v, t: Date.now() });
    }
  };
}
const placesCache = makeCache(CACHE_TTL_MS);
const geocodeCache = makeCache(GEOCODE_TTL_MS);

/** Very small per-IP rate limiter (best effort; resets on cold start). */
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'anon';
  const rec = hits.get(key) || { n: 0, t: now };
  if (now - rec.t > 60_000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  hits.set(key, rec);
  if (hits.size > 5000) hits.clear();
  if (rec.n > 90) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
  next();
}
app.use('/api', rateLimit);

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Which useful facts are missing for this place? Gives the score a human explanation. */
function missingFacts(tags, group) {
  const missing = [];
  if (!(tags.website || tags['contact:website'])) missing.push('website');
  if (!tags.opening_hours) missing.push('opening hours');
  if (!(tags.phone || tags['contact:phone'])) missing.push('phone');
  if (!tags.wheelchair) missing.push('wheelchair info');
  if (!(tags.wikipedia || tags.wikidata)) missing.push('wiki link');
  if (group === 'amenity' && ['restaurant', 'cafe', 'fast_food', 'bar', 'pub'].includes(tags.amenity) && !tags.cuisine) {
    missing.push('cuisine');
  }
  return missing;
}

function scoreFromTags(tagCount) {
  // Most POIs have at least 2 tags (name + a category). Every tag beyond that
  // (website, phone, hours, cuisine, wikidata, ...) means more has been
  // recorded, which lowers the silence score.
  return Math.max(0, Math.min(100, Math.round(100 - (tagCount - 2) * 11)));
}

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

// ------------------------------------------------------------------- routes

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

/**
 * GET /api/geocode?q=<place name>
 * Turns a place name into coordinates using Nominatim (OpenStreetMap).
 */
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter "q".' });
  if (q.length > 200) return res.status(400).json({ error: 'Search text is too long.' });

  const key = q.toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached) return res.json(cached);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' } }, 10000);
    if (!r.ok) throw new Error(`Nominatim responded with ${r.status}`);
    const data = await r.json();
    const out = data.map(d => ({
      display_name: d.display_name,
      lat: parseFloat(d.lat),
      lon: parseFloat(d.lon)
    }));
    geocodeCache.set(key, out);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the geocoding service.', detail: err.message });
  }
});

/**
 * GET /api/silence-map?lat=&lon=&radius=<meters>&types=amenity,shop,tourism,leisure
 *
 * Finds named points of interest (nodes AND ways, e.g. parks and buildings)
 * near a coordinate via the Overpass API, then scores each by how little is
 * documented about it. Absence of data is the signal.
 */
app.get('/api/silence-map', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Query parameters "lat" and "lon" must be valid coordinates.' });
  }
  const radius = Math.max(200, Math.min(parseInt(req.query.radius, 10) || 2000, 5000));

  const requested = String(req.query.types || '').split(',').map(s => s.trim()).filter(Boolean);
  const groups = requested.length ? ALL_GROUPS.filter(g => requested.includes(g)) : ALL_GROUPS;
  if (!groups.length) return res.status(400).json({ error: 'No valid place types selected.' });

  const cacheKey = `${lat.toFixed(3)}|${lon.toFixed(3)}|${radius}|${groups.join(',')}`;
  const cached = placesCache.get(cacheKey);
  if (cached) {
    // Distances depend on the exact centre, so recompute them for the cached set.
    const places = cached.map(p => ({ ...p, distance_m: haversine(lat, lon, p.lat, p.lon) }));
    return res.json({ count: places.length, radius, center: { lat, lon }, cached: true, places });
  }

  const query = `
    [out:json][timeout:25];
    (
      ${groups.map(g => `nwr["name"]["${g}"](around:${radius},${lat},${lon});`).join('\n      ')}
    );
    out center tags 500;
  `;

  let data;
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
        body: query
      });
      if (!r.ok) throw new Error(`Overpass responded with ${r.status}`);
      data = await r.json();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!data) {
    return res.status(502).json({ error: 'Could not reach the map data service. Please try again in a moment.', detail: lastErr && lastErr.message });
  }

  const seen = new Set();
  const places = [];
  for (const el of data.elements || []) {
    const tags = el.tags;
    const pLat = el.lat ?? (el.center && el.center.lat);
    const pLon = el.lon ?? (el.center && el.center.lon);
    if (!tags || !tags.name || pLat == null || pLon == null) continue;
    const uid = `${el.type}/${el.id}`;
    if (seen.has(uid)) continue;
    seen.add(uid);

    const group = groups.find(g => tags[g]) || 'amenity';
    const tagCount = Object.keys(tags).length;
    places.push({
      id: uid,
      name: tags.name,
      category: String(tags[group] || 'place').replace(/_/g, ' '),
      group,
      lat: pLat,
      lon: pLon,
      tag_count: tagCount,
      silence_score: scoreFromTags(tagCount),
      missing: missingFacts(tags, group),
      has_website: Boolean(tags.website || tags['contact:website']),
      has_wikipedia: Boolean(tags.wikipedia || tags.wikidata)
    });
  }

  places.sort((a, b) => b.silence_score - a.silence_score || a.tag_count - b.tag_count);
  const top = places.slice(0, MAX_RESULTS);
  placesCache.set(cacheKey, top);

  const withDistance = top.map(p => ({ ...p, distance_m: haversine(lat, lon, p.lat, p.lon) }));
  res.json({ count: withDistance.length, radius, center: { lat, lon }, cached: false, places: withDistance });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Silence Map running at http://localhost:${PORT}`);
  });
}

// Exported so serverless hosts (e.g. Vercel) can use the app directly.
module.exports = app;
