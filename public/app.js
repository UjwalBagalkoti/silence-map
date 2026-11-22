/* Silence Map front end.
 * All text from OpenStreetMap is user-contributed, so it is only ever inserted
 * with textContent / DOM nodes, never as HTML. */

const DEFAULT_CENTER = { lat: 12.9716, lon: 77.5946, label: 'Bengaluru' };

const state = {
  center: null,          // {lat, lon} of the last search
  label: '',             // human label for the search area
  radius: 2000,
  mode: 'quiet',         // 'quiet' (hidden places) or 'nature' (calm green spaces)
  types: new Set(['amenity', 'shop', 'tourism', 'leisure']),
  natureTypes: new Set(['green', 'wild', 'water', 'view']),
  sort: 'quiet',
  places: [],
  placesMode: 'quiet',   // mode the current places were loaded for
  noteShown: false,
  markers: new Map(),    // place id -> Leaflet marker
  user: null,            // {lat, lon, accuracy}
  watchId: null,
  lastWatchLoad: null,   // centre of the last load triggered by live tracking
  programmatic: false,   // true while the app itself is moving the map
  loadSeq: 0             // guards against out-of-order responses
};

const $ = id => document.getElementById(id);
const els = {
  list: $('placeList'), count: $('resultCount'), area: $('areaLabel'),
  radius: $('radiusSelect'), sort: $('sortSelect'), chips: $('typeChips'),
  modes: document.querySelector('.modes'), natureChips: $('natureChips'), modeTitle: $('modeTitle'),
  legendLow: $('legendLow'), legendHigh: $('legendHigh'), legendText: $('legendText'), sortBestOpt: $('sortBestOpt'),
  locate: $('locateBtn'), follow: $('followBtn'), searchArea: $('searchAreaBtn'),
  form: $('searchForm'), input: $('searchInput'), sugg: $('suggestions'), toast: $('toast')
};

let map, markersLayer, userMarker, accuracyCircle;

/* ------------------------------------------------------------------ utils */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  children.flat().forEach(c => c != null && node.append(c));
  return node;
}

function safeStorage(op, key, value) {
  try {
    if (op === 'get') return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* storage can be blocked; the app works without it */ }
  return null;
}

function haversine(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function scoreColor(score) {
  const t = score / 100;
  if (state.placesMode === 'nature') {
    // 0 = busy (muted gray), 100 = very calm and natural (green)
    return `rgb(${Math.round(60 + t * 10)},${Math.round(68 + t * 132)},${Math.round(64 + t * 56)})`;
  }
  // 0 = well documented (muted gray), 100 = practically undocumented (bright violet)
  return `rgb(${Math.round(60 + t * 85)},${Math.round(60 + t * 42)},${Math.round(68 + t * 150)})`;
}

function scoreOf(p) {
  return state.placesMode === 'nature' ? p.calm_score : p.silence_score;
}

function scoreLabel(score) {
  if (state.placesMode === 'nature') {
    if (score >= 80) return 'Very calm';
    if (score >= 65) return 'Calm';
    if (score >= 50) return 'Fairly calm';
    return 'Busy surroundings';
  }
  if (score >= 80) return 'Almost invisible';
  if (score >= 60) return 'Very quiet';
  if (score >= 40) return 'Quiet';
  return 'Well documented';
}

let toastTimer;
function toast(message, ms = 4500) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function directionsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`;
}

/* -------------------------------------------------------------------- map */

function initMap() {
  map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  // Offer "Search this area" once the user pans far from the last search.
  map.on('moveend', () => {
    if (state.programmatic) { state.programmatic = false; return; }
    if (!state.center) return;
    const c = map.getCenter();
    els.searchArea.hidden = haversine(state.center, { lat: c.lat, lon: c.lng }) < state.radius * 0.4;
  });
}

function flyTo(lat, lon, zoom) {
  state.programmatic = true;
  map.flyTo([lat, lon], zoom, { duration: 0.8 });
  // flyTo may not fire moveend if already there; reset the flag shortly after.
  setTimeout(() => { state.programmatic = false; }, 1200);
}

function zoomForRadius(r) {
  return r <= 500 ? 16 : r <= 1000 ? 15 : r <= 2000 ? 14 : 13;
}

/* -------------------------------------------------------------- user GPS */

function setUser(lat, lon, accuracy) {
  state.user = { lat, lon, accuracy };
  const ll = [lat, lon];
  if (!userMarker) {
    userMarker = L.marker(ll, {
      icon: L.divIcon({ className: '', html: '<div class="me-marker"><i></i><span></span></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000, interactive: false, keyboard: false
    }).addTo(map);
    accuracyCircle = L.circle(ll, { radius: accuracy || 30, color: '#4DA3FF', weight: 1, fillColor: '#4DA3FF', fillOpacity: 0.1, interactive: false }).addTo(map);
  } else {
    userMarker.setLatLng(ll);
    accuracyCircle.setLatLng(ll).setRadius(accuracy || 30);
  }
}

function geoErrorMessage(err) {
  if (!window.isSecureContext) return 'Location needs a secure (https) connection.';
  switch (err.code) {
    case 1: return 'Location permission is blocked. Allow it in your browser’s site settings, or search for a place instead.';
    case 2: return 'Your device could not work out its location. Check GPS or Wi-Fi, or search for a place.';
    case 3: return 'Finding your location took too long. Try again, or search for a place.';
    default: return 'Could not get your location. Try searching instead.';
  }
}

function getPosition(options) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

async function locateMe() {
  if (!navigator.geolocation) {
    toast('This browser does not support location. Try searching for a place.');
    return;
  }
  els.locate.classList.add('busy');
  toast('Finding your location…', 0);
  try {
    let pos;
    try {
      pos = await getPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    } catch (err) {
      if (err.code === 3) pos = await getPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      else throw err;
    }
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    setUser(lat, lon, accuracy);
    els.toast.hidden = true;
    if (accuracy > 1000) toast(`Your location is only accurate to about ${formatDistance(accuracy)}. Results may be less precise.`);
    await loadSilenceMap(lat, lon, 'Near you');
  } catch (err) {
    toast(geoErrorMessage(err), 7000);
  } finally {
    els.locate.classList.remove('busy');
  }
}

function toggleFollow() {
  if (state.watchId != null) { stopFollow(); return; }
  if (!navigator.geolocation) { toast('This browser does not support location.'); return; }
  state.lastWatchLoad = state.center;
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      const first = !state.user;
      setUser(lat, lon, accuracy);
      if (first) { flyTo(lat, lon, 16); }
      // Refresh the list when the user has moved a meaningful distance.
      const base = state.lastWatchLoad || state.center;
      if (first || !base || haversine(base, { lat, lon }) > Math.max(250, state.radius * 0.35)) {
        state.lastWatchLoad = { lat, lon };
        loadSilenceMap(lat, lon, 'Near you', { keepView: !first });
      }
    },
    err => { toast(geoErrorMessage(err), 7000); stopFollow(); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
  els.follow.setAttribute('aria-pressed', 'true');
  toast('Live tracking on. The list updates as you move.');
}

function stopFollow() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  els.follow.setAttribute('aria-pressed', 'false');
}

/* -------------------------------------------------------------- rendering */

function showSkeleton() {
  els.list.replaceChildren(...Array.from({ length: 4 }, () => el('div', { class: 'skeleton' })));
}

function showMessage(text, actionLabel, action) {
  const p = el('div', { class: 'empty-state' }, el('p', { text }));
  if (actionLabel) p.append(el('button', { type: 'button', text: actionLabel, onclick: action }));
  els.list.replaceChildren(p);
}

function distanceOf(p) {
  const from = state.user || state.center;
  return from ? haversine(from, p) : p.distance_m;
}

function sortedPlaces() {
  const arr = state.places.map(p => ({ ...p, _d: distanceOf(p) }));
  if (state.sort === 'near') arr.sort((a, b) => a._d - b._d);
  else arr.sort((a, b) => scoreOf(b) - scoreOf(a) || a.tag_count - b.tag_count);
  return arr;
}

function popupFor(p) {
  return el('div', {},
    el('div', { class: 'pop-title', text: p.name }),
    el('div', { class: 'pop-meta' }, el('span', { class: 'cat', text: p.category }), ` · ${formatDistance(p._d)} away`),
    state.placesMode === 'nature'
      ? el('div', { text: `Calm score ${p.calm_score} · ${p.noise_level}` })
      : el('div', { text: `Silence score ${p.silence_score} (${scoreLabel(p.silence_score).toLowerCase()})` }),
    el('a', { href: directionsUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'Walking directions ↗' })
  );
}

function renderPlaces() {
  markersLayer.clearLayers();
  state.markers.clear();
  const places = sortedPlaces();
  els.count.textContent = `${places.length} found`;

  if (!places.length) {
    showMessage(state.placesMode === 'nature'
      ? 'No named parks, forests or water found here. Try a wider radius, more nature types, or a different spot.'
      : 'Nothing unusually quiet turned up here. Try a wider radius, more place types, or a different spot.');
    return;
  }

  const cards = places.map(p => {
    const score = scoreOf(p);
    const color = scoreColor(score);
    const nature = state.placesMode === 'nature';
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 6 + score / 12, fillColor: color, fillOpacity: 0.85, color, weight: 1
    }).bindPopup(() => popupFor(p));
    marker.addTo(markersLayer);
    state.markers.set(p.id, marker);

    const open = () => {
      document.querySelectorAll('.place-card.active').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      flyTo(p.lat, p.lon, 17);
      setTimeout(() => marker.openPopup(), 300);
      if (window.matchMedia('(max-width: 820px)').matches) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    marker.on('click', () => {
      document.querySelectorAll('.place-card.active').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    const why = nature
      ? (p.silence_score >= 80 ? 'Few details online, so it may be a hidden gem.' : 'Well known and documented.')
      : (p.missing.length ? `Not recorded: ${p.missing.slice(0, 4).join(', ')}` : 'Fairly well documented');
    const noiseClass = p.noise == null ? 'unknown' : p.noise < 15 ? 'peaceful' : p.noise < 40 ? 'some' : 'busy';
    const card = el('div', { class: 'place-card', role: 'button', tabindex: '0', 'aria-label': `${p.name}, ${nature ? 'calm' : 'silence'} score ${score}. Show on map.` },
      el('div', { class: 'place-card-top' },
        el('span', { class: 'place-name', text: p.name }),
        el('span', { class: 'place-score', style: `color:${color}`, text: String(score) })),
      el('div', { class: 'place-meta' }, el('span', { class: 'cat', text: p.category }), ` · ${formatDistance(p._d)} away`),
      el('div', { class: 'place-why', text: why }),
      el('div', { class: 'place-actions' },
        el('a', { href: directionsUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'Directions ↗',
                  onclick: e => e.stopPropagation(), onkeydown: e => e.stopPropagation() }),
        nature ? el('span', { class: `noise ${noiseClass}`, text: p.noise_level }) : null,
        el('span', { class: 'badge', text: scoreLabel(score) }))
    );
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return card;
  });
  els.list.replaceChildren(...cards);
}

/* ------------------------------------------------------------------ loading */

function updateUrl() {
  try {
    const u = new URL(location.href);
    u.searchParams.set('lat', state.center.lat.toFixed(5));
    u.searchParams.set('lon', state.center.lon.toFixed(5));
    u.searchParams.set('r', String(state.radius));
    u.searchParams.set('mode', state.mode);
    history.replaceState(null, '', u);
  } catch (_) { /* ignore */ }
}

async function loadSilenceMap(lat, lon, label, { keepView = false } = {}) {
  const seq = ++state.loadSeq;
  state.center = { lat, lon };
  state.label = label || state.label;
  els.searchArea.hidden = true;
  els.area.textContent = `${state.label || 'Selected area'} · within ${formatDistance(state.radius)}`;
  if (!keepView) flyTo(lat, lon, zoomForRadius(state.radius));
  showSkeleton();
  els.count.textContent = '…';
  safeStorage('set', 'silence-map:last', { lat, lon, label: state.label });
  updateUrl();

  try {
    const mode = state.mode;
    const types = mode === 'nature' ? state.natureTypes : state.types;
    const qs = new URLSearchParams({ lat, lon, radius: state.radius, mode, types: [...types].join(',') });
    const res = await fetch(`/api/silence-map?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (seq !== state.loadSeq) return; // a newer search replaced this one
    if (!res.ok) throw new Error(data.error || 'The server could not process that location.');
    state.places = data.places;
    state.placesMode = data.mode || mode;
    renderPlaces();
    if (state.placesMode === 'nature') {
      if (data.noise_available === false) toast('Could not check road noise right now, so calm scores are rough estimates.', 6000);
      else if (data.noise_partial) toast('This area is very busy, so the noise estimate may be incomplete. Try a smaller radius.', 6000);
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    els.count.textContent = '—';
    showMessage(`Could not load places: ${err.message}`, 'Try again', () => loadSilenceMap(lat, lon, label, { keepView: true }));
  }
}

/* ------------------------------------------------------------------- search */

let suggestTimer, suggestSeq = 0, suggestions = [], activeIdx = -1;

function hideSuggestions() { els.sugg.hidden = true; els.sugg.replaceChildren(); suggestions = []; activeIdx = -1; }

function pickLocation(r) {
  hideSuggestions();
  els.input.value = r.display_name.split(',').slice(0, 2).join(',').trim();
  stopFollow();
  loadSilenceMap(r.lat, r.lon, r.display_name.split(',')[0].trim());
}

function renderSuggestions(results, note) {
  suggestions = results;
  activeIdx = -1;
  els.sugg.replaceChildren(
    ...(note ? [el('li', { class: 'note', text: note })] : results.map((r, i) =>
      el('li', { role: 'option', text: r.display_name, onmousedown: e => { e.preventDefault(); pickLocation(r); } })))
  );
  els.sugg.hidden = false;
}

async function fetchSuggestions(q) {
  const seq = ++suggestSeq;
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    if (seq !== suggestSeq) return;
    if (!res.ok) throw new Error(results.error);
    renderSuggestions(results, results.length ? null : 'No matches. Try a different spelling.');
  } catch (_) {
    if (seq === suggestSeq) renderSuggestions([], 'Search is unavailable right now.');
  }
}

els.input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = els.input.value.trim();
  if (q.length < 3) { suggestSeq++; hideSuggestions(); return; }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 500); // be polite to the free geocoder
});

els.input.addEventListener('keydown', e => {
  const items = [...els.sugg.querySelectorAll('li[role="option"]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
  } else if (e.key === 'Escape') hideSuggestions();
});

document.addEventListener('click', e => { if (!els.form.contains(e.target)) hideSuggestions(); });

els.form.addEventListener('submit', async e => {
  e.preventDefault();
  clearTimeout(suggestTimer);
  if (activeIdx >= 0 && suggestions[activeIdx]) return pickLocation(suggestions[activeIdx]);
  const q = els.input.value.trim();
  if (!q) return;
  if (suggestions.length) return pickLocation(suggestions[0]);
  showSkeleton();
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    if (!res.ok) throw new Error(results.error);
    if (!results.length) return showMessage('No location found. Try another search.');
    pickLocation(results[0]);
  } catch (err) {
    showMessage(`Search failed: ${err.message}`);
  }
});

/* ----------------------------------------------------------------- controls */

els.locate.addEventListener('click', () => { stopFollow(); locateMe(); });
els.follow.addEventListener('click', toggleFollow);
els.searchArea.addEventListener('click', () => {
  const c = map.getCenter();
  stopFollow();
  loadSilenceMap(c.lat, c.lng, 'Map area', { keepView: true });
});

let reloadTimer;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => state.center && loadSilenceMap(state.center.lat, state.center.lon, state.label, { keepView: true }), 250);
}

els.radius.addEventListener('change', () => { state.radius = parseInt(els.radius.value, 10); reloadSoon(); });
els.sort.addEventListener('change', () => { state.sort = els.sort.value; renderPlaces(); });
function wireChips(container, set) {
  container.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const type = chip.dataset.type;
    if (set.has(type)) {
      if (set.size === 1) { toast('Keep at least one place type selected.'); return; }
      set.delete(type);
    } else set.add(type);
    chip.classList.toggle('on', set.has(type));
    chip.setAttribute('aria-pressed', String(set.has(type)));
    reloadSoon();
  });
}
wireChips(els.chips, state.types);
wireChips(els.natureChips, state.natureTypes);

function applyMode() {
  const nature = state.mode === 'nature';
  document.body.classList.toggle('nature', nature);
  els.modes.querySelectorAll('.mode').forEach(b => {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  els.chips.hidden = nature;
  els.natureChips.hidden = !nature;
  els.modeTitle.textContent = nature ? 'Calm nature spots' : 'Quietest spots';
  els.sortBestOpt.textContent = nature ? 'Calmest first' : 'Quietest first';
  els.legendLow.textContent = nature ? 'Busy surroundings' : 'Well documented';
  els.legendHigh.textContent = nature ? 'Very calm & natural' : 'Almost invisible';
  els.legendText.textContent = nature
    ? 'Calm score combines how far a park, forest or lake is from busy roads and railways (an estimate from map data), how natural it is, and a small bonus if little is recorded about it. Higher means a more peaceful, greener spot.'
    : 'The score shows how little is recorded about a place on OpenStreetMap — no website, hours or phone. Higher means quieter.';
}

els.modes.addEventListener('click', e => {
  const btn = e.target.closest('.mode');
  if (!btn || btn.dataset.mode === state.mode) return;
  state.mode = btn.dataset.mode;
  applyMode();
  state.places = [];
  reloadSoon();
});

window.addEventListener('pagehide', stopFollow);

/* -------------------------------------------------------------------- start */

async function start() {
  initMap();

  // 1) a shared link, 2) your last search, 3) your location if already allowed, 4) the default city.
  const params = new URLSearchParams(location.search);
  const qLat = parseFloat(params.get('lat')), qLon = parseFloat(params.get('lon')), qR = parseInt(params.get('r'), 10);
  if ([500, 1000, 2000, 5000].includes(qR)) { state.radius = qR; els.radius.value = String(qR); }
  if (params.get('mode') === 'nature') { state.mode = 'nature'; applyMode(); }

  if (Number.isFinite(qLat) && Number.isFinite(qLon) && Math.abs(qLat) <= 90 && Math.abs(qLon) <= 180) {
    map.setView([qLat, qLon], zoomForRadius(state.radius));
    return loadSilenceMap(qLat, qLon, 'Shared area', { keepView: true });
  }

  let allowed = false;
  try {
    if (navigator.permissions && navigator.geolocation) {
      const p = await navigator.permissions.query({ name: 'geolocation' });
      allowed = p.state === 'granted';
    }
  } catch (_) { /* older browsers */ }

  if (allowed) {
    map.setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], 13);
    return locateMe();
  }

  const last = safeStorage('get', 'silence-map:last');
  const begin = last && Number.isFinite(last.lat) && Number.isFinite(last.lon) ? last : DEFAULT_CENTER;
  map.setView([begin.lat, begin.lon], zoomForRadius(state.radius));
  await loadSilenceMap(begin.lat, begin.lon, begin.label || 'Last search', { keepView: true });
  if (begin === DEFAULT_CENTER) toast('Showing Bengaluru. Tap “My location” to see quiet spots near you.', 7000);
}

start();
