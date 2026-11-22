require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const USER_AGENT = 'SilenceMap/1.1 (github.com/UjwalBagalkoti/silence-map)';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const OVERPASS_HEDGE_MS = 1500;   // start the next mirror if the current one is slow
const OVERPASS_ATTEMPT_MS = 14000;
const ALL_GROUPS = ['amenity', 'shop', 'tourism', 'leisure'];
const MAX_RESULTS = 60;
const MAX_RADIUS = 300000;      // 300 km
const WIDE_RADIUS = 10000;      // beyond this only notable places are searched, to keep the query fast
const WIDE_ATTEMPT_MS = 40000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const GEOCODE_TTL_MS = 60 * 60 * 1000;

app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------- helpers

/** Tiny in-memory TTL cache so repeated searches don't hammer free public APIs. */
function makeCache(ttl, maxEntries = 300) {
  const store = new Map();
  return {
    get(key, { allowStale = false } = {}) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (!allowStale && Date.now() - hit.t > ttl) return undefined;
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

// ------------------------------------------------------------------ photos
// Google Places photos when GOOGLE_PLACES_API_KEY is set (needs billing on the Google Cloud project),
// otherwise freely licensed nearby photos from Wikimedia Commons.
const photoCache = makeCache(24 * 60 * 60 * 1000, 500);

async function googlePhotos(name, lat, lon, key) {
  const r = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.googleMapsUri,places.photos'
    },
    body: JSON.stringify({
      textQuery: name,
      maxResultCount: 1,
      locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 150 } }
    })
  }, 8000);
  if (!r.ok) throw new Error(`Google Places ${r.status}`);
  const place = ((await r.json()).places || [])[0];
  if (!place || !place.photos || !place.photos.length) return [];
  const out = [];
  for (const ph of place.photos.slice(0, 3)) {
    const m = await fetchWithTimeout(
      `https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=600&skipHttpRedirect=true&key=${encodeURIComponent(key)}`, {}, 8000);
    if (!m.ok) continue;
    const j = await m.json();
    if (!j.photoUri) continue;
    const a = (ph.authorAttributions || [])[0] || {};
    out.push({ url: j.photoUri, credit: a.displayName || 'Google Maps contributor', link: a.uri || place.googleMapsUri || null, source: 'Google' });
  }
  return out;
}

async function commonsPhotos(lat, lon) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=geosearch&ggsnamespace=6' +
    `&ggscoord=${lat}%7C${lon}&ggsradius=300&ggslimit=8&prop=imageinfo&iiprop=url%7Cextmetadata%7Cmime&iiurlwidth=600&origin=*`;
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 8000);
  if (!r.ok) throw new Error(`Commons ${r.status}`);
  const pages = Object.values(((await r.json()).query || {}).pages || {});
  const strip = h => String(h || '').replace(/<[^>]*>/g, '').trim();
  return pages
    .map(pg => (pg.imageinfo || [])[0] && { pg, ii: pg.imageinfo[0] })
    .filter(x => x && /^image\/(jpeg|png|webp)$/.test(x.ii.mime || '') && x.ii.thumburl)
    .slice(0, 3)
    .map(({ pg, ii }) => {
      const md = ii.extmetadata || {};
      return {
        url: ii.thumburl,
        credit: strip(md.Artist && md.Artist.value).slice(0, 60) || 'Wikimedia Commons',
        license: strip(md.LicenseShortName && md.LicenseShortName.value) || null,
        link: ii.descriptionshorturl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(pg.title)}`,
        source: 'Wikimedia Commons'
      };
    });
}

app.get('/api/place-photos', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const name = String(req.query.name || '').slice(0, 120);
  if (Number.isNaN(lat) || Number.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Valid "lat" and "lon" are required.' });
  }
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const cacheKey = `${name}|${lat.toFixed(4)}|${lon.toFixed(4)}|${key ? 'g' : 'c'}`;
  const hit = photoCache.get(cacheKey);
  if (hit) return res.json(hit);
  let photos = [];
  try {
    if (key && name) {
      try { photos = await googlePhotos(name, lat, lon, key); } catch (e) { console.error('google photos failed:', e.message); }
    }
    if (!photos.length) photos = await commonsPhotos(lat, lon);
  } catch (e) {
    console.error('photo lookup failed:', e.message);
    return res.json({ photos: [] });   // not cached, so it can be retried
  }
  const body = { photos };
  photoCache.set(cacheKey, body);
  res.json(body);
});

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
 * Run an Overpass query against several public mirrors. Cloud hosts are often
 * rate-limited or slow on any single mirror, so if the first has not answered
 * after a few seconds the next one is started too, and the first success wins.
 */
function overpass(query, attemptMs = OVERPASS_ATTEMPT_MS) {
  return new Promise((resolve, reject) => {
    const controllers = [];
    let hedgeTimer = null;
    let nextIdx = 0;
    let running = 0;
    let done = false;
    let lastErr;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      controllers.forEach(c => c.abort());
      fn(value);
    };

    // Start the next mirror, and schedule another one in case this one is slow.
    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (done || nextIdx >= OVERPASS_ENDPOINTS.length) return false;
      const endpoint = OVERPASS_ENDPOINTS[nextIdx++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const timeout = setTimeout(() => ctrl.abort(), attemptMs);
      running += 1;
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
        body: query,
        signal: ctrl.signal
      })
        .then(r => {
          if (!r.ok) throw new Error(`Overpass responded with ${r.status}`);
          return r.json();
        })
        .then(data => {
          // Overpass reports server-side timeouts as a "remark" with an empty result.
          if (data && data.remark && /timed out|out of memory/i.test(data.remark) && !(data.elements || []).length) {
            throw new Error('Overpass query timed out');
          }
          clearTimeout(timeout);
          finish(resolve, data);
        })
        .catch(err => {
          clearTimeout(timeout);
          if (done) return;
          lastErr = err;
          running -= 1;
          // A failed mirror hands over to the next one straight away.
          if (!startNext() && running === 0) finish(reject, lastErr || new Error('Overpass unavailable'));
        });
      if (nextIdx < OVERPASS_ENDPOINTS.length) hedgeTimer = setTimeout(startNext, OVERPASS_HEDGE_MS);
      return true;
    };

    startNext();
  });
}

/* ------------------------------------------------------------ nature mode */

// How "natural" each OSM feature type is (0-100) and which filter group it belongs to.
const NATURE_TYPES = {
  forest: [100, 'wild'], wood: [100, 'wild'], nature_reserve: [100, 'wild'], national_park: [100, 'wild'],
  protected_area: [95, 'wild'], wetland: [90, 'wild'], heath: [85, 'wild'], grassland: [72, 'wild'], scrub: [70, 'wild'],
  water: [88, 'water'], beach: [88, 'water'], spring: [80, 'water'],
  peak: [85, 'view'], cliff: [75, 'view'], viewpoint: [65, 'view'],
  park: [72, 'green'], garden: [68, 'green'], meadow: [72, 'green'], common: [60, 'green'], village_green: [55, 'green']
};
const NATURE_KEYS = ['leisure', 'natural', 'landuse', 'boundary', 'tourism'];
const NATURE_CLAUSES = {
  green: [['leisure', 'park|garden|common'], ['landuse', 'meadow|village_green']],
  wild: [['leisure', 'nature_reserve'], ['natural', 'wood|scrub|heath|grassland|wetland'], ['landuse', 'forest'], ['boundary', 'national_park|protected_area']],
  water: [['natural', 'water|beach|spring']],
  view: [['tourism', 'viewpoint'], ['natural', 'peak|cliff']]
};
const NATURE_GROUPS = Object.keys(NATURE_CLAUSES);

// Noise sources: how far (metres) their noise is felt and how strongly.
const NOISE_CLASSES = {
  motorway: { reach: 350, w: 1.0 }, trunk: { reach: 300, w: 1.0 },
  primary: { reach: 220, w: 0.85 }, secondary: { reach: 140, w: 0.6 },
  rail: { reach: 180, w: 0.6 }
};
const NOISE_MAX_REACH = 350;

function natureKind(tags) {
  for (const key of NATURE_KEYS) {
    const v = tags[key];
    if (v && NATURE_TYPES[v]) return v;
  }
  return null;
}

/** Turn Overpass way geometries into compact noise-source records. */
function parseNoiseWays(elements) {
  const ways = [];
  for (const el of elements || []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2 || !el.tags) continue;
    const cls = el.tags.railway === 'rail' ? 'rail' : el.tags.highway;
    const spec = NOISE_CLASSES[cls];
    if (!spec) continue;
    const pts = el.geometry.map(g => [g.lat, g.lon]);
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const [la, lo] of pts) {
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    }
    ways.push({ spec, pts, minLat, maxLat, minLon, maxLon });
  }
  return ways;
}

/** Estimated traffic/rail noise exposure (0-100) at a point; 0 = nothing noisy nearby. */
function noiseAt(lat, lon, ways) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const padLat = NOISE_MAX_REACH / mLat;
  const padLon = NOISE_MAX_REACH / mLon;
  let worst = 0;
  for (const w of ways) {
    if (lat < w.minLat - padLat || lat > w.maxLat + padLat || lon < w.minLon - padLon || lon > w.maxLon + padLon) continue;
    let best = Infinity;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const ax = (w.pts[i][1] - lon) * mLon, ay = (w.pts[i][0] - lat) * mLat;
      const bx = (w.pts[i + 1][1] - lon) * mLon, by = (w.pts[i + 1][0] - lat) * mLat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
    const exposure = Math.max(0, 1 - best / w.spec.reach) * w.spec.w;
    if (exposure > worst) worst = exposure;
  }
  return Math.round(worst * 100);
}

function noiseLabel(n) {
  if (n == null) return 'Noise unknown';
  if (n < 15) return 'Peaceful';
  if (n < 40) return 'Some traffic noise';
  return 'Busy road nearby';
}

/**
 * Calm score for nature spots: mostly how far the place is from busy roads and
 * railways, plus how natural the feature is, plus a small bonus when little is
 * recorded about it (a hidden gem).
 */
function calmScore(peace, naturalness, hidden) {
  return Math.round(0.55 * peace + 0.30 * naturalness + 0.15 * hidden);
}

const NATURE_WIDE = {
  green: [['leisure', 'park|garden', '[wikidata]']],
  wild: [['leisure', 'nature_reserve', ''], ['boundary', 'national_park|protected_area', '']],
  water: [['natural', 'beach|spring', ''], ['natural', 'water', '[wikidata]']],
  view: [['tourism', 'viewpoint', ''], ['natural', 'peak', '[wikidata]']]
};

async function natureMap(lat, lon, radius, groups) {
  const wide = radius > WIDE_RADIUS;
  const clauses = wide
    ? groups.flatMap(g => NATURE_WIDE[g].map(([k, v, extra]) => `nwr["name"]["${k}"~"^(${v})$"]${extra}(around:${radius},${lat},${lon});`))
    : groups.flatMap(g => NATURE_CLAUSES[g].map(([k, v]) => `nwr["name"]["${k}"~"^(${v})$"](around:${radius},${lat},${lon});`));
  const natureQuery = `[out:json][timeout:${wide ? 45 : 25}];(${clauses.join('')});out center tags ${wide ? 1500 : 500};`;
  const noiseQuery = `[out:json][timeout:25];(
    way["highway"~"^(motorway|trunk|primary|secondary)$"](around:${radius + NOISE_MAX_REACH},${lat},${lon});
    way["railway"="rail"](around:${radius + NOISE_MAX_REACH},${lat},${lon});
  );out body geom 8000;`;

  const [natureRes, noiseRes] = await Promise.allSettled([
    overpass(natureQuery, wide ? WIDE_ATTEMPT_MS : undefined),
    wide ? Promise.reject(new Error('road noise is not checked for wide searches')) : overpass(noiseQuery)
  ]);
  if (natureRes.status === 'rejected') throw natureRes.reason;

  const noiseOk = noiseRes.status === 'fulfilled';
  const noiseElements = noiseOk ? noiseRes.value.elements || [] : [];
  const ways = noiseOk ? parseNoiseWays(noiseElements) : [];

  const seen = new Set();
  const places = [];
  for (const el of natureRes.value.elements || []) {
    const tags = el.tags;
    const pLat = el.lat ?? (el.center && el.center.lat);
    const pLon = el.lon ?? (el.center && el.center.lon);
    if (!tags || !tags.name || pLat == null || pLon == null) continue;
    const uid = `${el.type}/${el.id}`;
    if (seen.has(uid)) continue;
    const kind = natureKind(tags);
    if (!kind) continue;
    seen.add(uid);

    const [naturalness, group] = NATURE_TYPES[kind];
    const tagCount = Object.keys(tags).length;
    const hidden = scoreFromTags(tagCount);
    const noise = noiseOk ? noiseAt(pLat, pLon, ways) : null;
    const peace = noise == null ? 60 : 100 - noise; // unknown noise: assume middling
    places.push({
      id: uid,
      name: tags.name,
      category: kind.replace(/_/g, ' '),
      group,
      lat: pLat,
      lon: pLon,
      tag_count: tagCount,
      silence_score: hidden,
      naturalness,
      noise,
      noise_level: noiseLabel(noise),
      calm_score: calmScore(peace, naturalness, hidden),
      missing: missingFacts(tags, group),
      opening_hours: tags.opening_hours ? String(tags.opening_hours).slice(0, 200) : undefined
    });
  }

  places.sort((a, b) => b.calm_score - a.calm_score || b.naturalness - a.naturalness);
  if (wide) places.forEach(p => { p.noise_level = 'Road noise not checked'; });
  return {
    places: places.slice(0, MAX_RESULTS),
    noiseAvailable: noiseOk,
    noisePartial: noiseOk && noiseElements.length >= 8000
  };
}

/**
 * GET /api/silence-map?lat=&lon=&radius=<meters>&mode=quiet|nature&types=...
 *
 * mode=quiet  (default): named points of interest scored by how little is
 *   documented about them (types: amenity, shop, tourism, leisure).
 * mode=nature: parks, forests, lakes, viewpoints etc. scored by how calm they
 *   are (distance from busy roads/rail) and how natural they are
 *   (types: green, wild, water, view).
 */
app.get('/api/silence-map', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Query parameters "lat" and "lon" must be valid coordinates.' });
  }
  const radius = Math.max(200, Math.min(parseInt(req.query.radius, 10) || 2000, MAX_RADIUS));
  const mode = req.query.mode === 'nature' ? 'nature' : 'quiet';

  const allowed = mode === 'nature' ? NATURE_GROUPS : ALL_GROUPS;
  const requested = String(req.query.types || '').split(',').map(s => s.trim()).filter(Boolean);
  const groups = requested.length ? allowed.filter(g => requested.includes(g)) : allowed;
  if (!groups.length) return res.status(400).json({ error: 'No valid place types selected.' });

  const cacheKey = `${mode}|${lat.toFixed(3)}|${lon.toFixed(3)}|${radius}|${groups.join(',')}`;
  const cached = placesCache.get(cacheKey);
  if (cached) {
    // Distances depend on the exact centre, so recompute them for the cached set.
    const places = cached.places.map(p => ({ ...p, distance_m: haversine(lat, lon, p.lat, p.lon) }));
    return res.json({ mode, count: places.length, radius, center: { lat, lon }, cached: true, ...cached.meta, places });
  }

  let places, meta = {};
  try {
    if (mode === 'nature') {
      const r = await natureMap(lat, lon, radius, groups);
      places = r.places;
      meta = { noise_available: r.noiseAvailable, noise_partial: r.noisePartial };
    } else {
      const wide = radius > WIDE_RADIUS;
      // Wide searches only look at notable quiet-type places, otherwise the query would never finish.
      const WIDE_QUIET = {
        amenity: '["amenity"~"^(place_of_worship|library|cafe)$"]["wikidata"]',
        shop: null,
        tourism: '["tourism"~"^(attraction|viewpoint|museum|gallery|artwork)$"]',
        leisure: '["leisure"~"^(park|garden|nature_reserve)$"]'
      };
      const clauses = wide
        ? groups.map(g => WIDE_QUIET[g]).filter(Boolean).map(f => `nwr["name"]${f}(around:${radius},${lat},${lon});`)
        : groups.map(g => `nwr["name"]["${g}"](around:${radius},${lat},${lon});`);
      if (!clauses.length) return res.json({ mode, count: 0, radius, center: { lat, lon }, cached: false, places: [] });
      const query = `
        [out:json][timeout:${wide ? 45 : 25}];
        (
          ${clauses.join('\n          ')}
        );
        out center tags ${wide ? 1500 : 500};
      `;
      const data = await overpass(query, wide ? WIDE_ATTEMPT_MS : undefined);
      const seen = new Set();
      places = [];
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
          opening_hours: tags.opening_hours ? String(tags.opening_hours).slice(0, 200) : undefined,
          has_website: Boolean(tags.website || tags['contact:website']),
          has_wikipedia: Boolean(tags.wikipedia || tags.wikidata)
        });
      }
      places.sort((a, b) => b.silence_score - a.silence_score || a.tag_count - b.tag_count);
      places = places.slice(0, MAX_RESULTS);
    }
  } catch (err) {
    // Serve the last good result for this spot (even if old) rather than nothing.
    const stale = placesCache.get(cacheKey, { allowStale: true });
    if (stale) {
      const old = stale.places.map(p => ({ ...p, distance_m: haversine(lat, lon, p.lat, p.lon) }));
      return res.json({ mode, count: old.length, radius, center: { lat, lon }, cached: true, stale: true, ...stale.meta, places: old });
    }
    return res.status(502).json({ error: 'The free map data servers are busy right now. Please try again in a moment.', detail: err && err.message });
  }

  placesCache.set(cacheKey, { places, meta });
  const withDistance = places.map(p => ({ ...p, distance_m: haversine(lat, lon, p.lat, p.lon) }));
  res.json({ mode, count: withDistance.length, radius, center: { lat, lon }, cached: false, ...meta, places: withDistance });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Silence Map running at http://localhost:${PORT}`);
  });
}

// Exported so serverless hosts (e.g. Vercel) can use the app directly.
module.exports = app;
