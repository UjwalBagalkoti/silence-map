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
  view: 'results',       // 'results' or 'saved'
  selectedId: null,
  pendingPlace: null,    // place id from a shared link, opened once results load
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
  savedBtn: $('savedBtn'), savedCount: $('savedCount'), intro: $('intro'), introClose: $('introClose'), helpBtn: $('helpBtn'), installBtn: $('installBtn'), themeBtn: $('themeBtn'),
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
  // Traffic-light colours anyone can read: green = quiet, amber = fairly quiet, orange = busier.
  return score >= 70 ? '#1FA95B' : score >= 45 ? '#E3A21A' : '#E8663D';
}

function scoreOf(p) {
  return p.mode === 'nature' ? p.calm_score : p.silence_score;
}

function scoreLabel(score, mode) {
  if (mode === 'nature') return score >= 70 ? 'Very calm' : score >= 45 ? 'Fairly calm' : 'Near busy roads';
  return score >= 70 ? 'Very quiet' : score >= 45 ? 'Fairly quiet' : 'Busier / well known';
}

/* ------------------------------------------------------ opening hours (simple) */

const DAY_IDX = { Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 };
const DAY_RE = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
const DAY_LIST_RE = new RegExp(`^(${DAY_RE}(?:-${DAY_RE})?(?:,${DAY_RE}(?:-${DAY_RE})?)*)\\s+(.+)$`);

/** Understands the common OpenStreetMap formats ("24/7", "Mo-Fr 09:00-18:00; Sa 10:00-14:00"). Returns null for anything fancier. */
function parseHours(str) {
  if (!str) return null;
  const text = String(str).trim();
  if (/^24\/7$/i.test(text)) return { always: true };
  const days = Array.from({ length: 7 }, () => []);
  for (const raw of text.split(';')) {
    const rule = raw.trim().replace(/\s*,\s*/g, ',');
    if (!rule) continue;
    const m = rule.match(DAY_LIST_RE);
    const dayText = m ? m[1] : null;
    const timeText = (m ? m[2] : rule).trim();

    let intervals;
    if (/^(off|closed)$/i.test(timeText)) intervals = [];
    else if (/^24\/7$/i.test(timeText)) intervals = [[0, 1440]];
    else {
      intervals = [];
      for (const part of timeText.split(',')) {
        const t = part.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
        if (!t) return null;                       // months, holidays, sunrise... not supported
        const start = +t[1] * 60 + +t[2];
        let end = +t[3] * 60 + +t[4];
        if (end <= start) end += 1440;             // runs past midnight
        intervals.push([start, end]);
      }
    }

    const targets = new Set();
    if (!dayText) [0, 1, 2, 3, 4, 5, 6].forEach(d => targets.add(d));
    else {
      for (const item of dayText.split(',')) {
        const [a, b] = item.split('-');
        let d = DAY_IDX[a];
        const last = b ? DAY_IDX[b] : d;
        for (let guard = 0; guard < 8; guard++) { targets.add(d); if (d === last) break; d = (d + 1) % 7; }
      }
    }
    targets.forEach(d => { days[d] = intervals; });  // later rules override earlier ones
  }
  return { days };
}

function hhmm(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function openStatus(parsed, now) {
  if (!parsed) return null;
  if (parsed.always) return { open: true, detail: 'open 24 hours' };
  const mins = now.getHours() * 60 + now.getMinutes();
  const d = (now.getDay() + 6) % 7;                 // Monday = 0
  for (const [s, e] of parsed.days[d]) {
    if (mins >= s && mins < e) return { open: true, detail: `closes ${hhmm(e)}` };
  }
  for (const [s, e] of parsed.days[(d + 6) % 7]) { // yesterday's late-night interval
    if (e > 1440 && mins + 1440 >= s && mins + 1440 < e) return { open: true, detail: `closes ${hhmm(e)}` };
  }
  const next = parsed.days[d].filter(([s]) => s > mins).sort((a, b) => a[0] - b[0])[0];
  return { open: false, detail: next ? `opens ${hhmm(next[0])}` : 'closed for today' };
}

/** What to show about a place's hours. Open/closed is only claimed when you are probably in the same time zone. */
function hoursInfo(p) {
  if (!p.opening_hours) return null;
  const parsed = parseHours(p.opening_hours);
  const near = state.user && haversine(state.user, p) < 150000;
  const status = parsed && near ? openStatus(parsed, new Date()) : null;
  let tip = null;
  if (parsed && !parsed.always) {
    const starts = parsed.days.flat().map(([s]) => s);
    const earliest = starts.length ? Math.min(...starts) : null;
    if (earliest != null && earliest <= 8 * 60) tip = `Tip: opens from ${hhmm(earliest)}. Early morning is usually the calmest time.`;
  }
  return { text: p.opening_hours, status, tip };
}

/* ----------------------------------------------------------- share and OSM */

function osmUrl(p) { return `https://www.openstreetmap.org/${p.id}`; }
function osmEditUrl(p) {
  const [type, num] = String(p.id).split('/');
  return `https://www.openstreetmap.org/edit?${type}=${num}`;
}

function placeLink(p) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('lat', p.lat.toFixed(5));
  u.searchParams.set('lon', p.lon.toFixed(5));
  u.searchParams.set('r', '500');
  u.searchParams.set('mode', p.mode);
  u.searchParams.set('place', p.id);
  return u.toString();
}

async function sharePlace(p) {
  const url = placeLink(p);
  if (navigator.share) {
    try { await navigator.share({ title: `${p.name} · Silence Map`, text: `${p.name}: a quiet spot on Silence Map`, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it anywhere to share this place.'); }
  catch (_) { toast(`Copy this link: ${url}`, 12000); }
}

/* --------------------------------------------------------------- favourites */

const FAV_KEY = 'silence-map:favs';
const FAV_FIELDS = ['id', 'name', 'category', 'group', 'lat', 'lon', 'mode', 'tag_count', 'silence_score', 'calm_score',
  'naturalness', 'noise', 'noise_level', 'missing'];

function getFavs() {
  const v = safeStorage('get', FAV_KEY);
  return Array.isArray(v) ? v : [];
}
function isFav(p) { return getFavs().some(f => f.id === p.id && f.mode === p.mode); }

function toggleFav(p) {
  let favs = getFavs();
  if (isFav(p)) {
    favs = favs.filter(f => !(f.id === p.id && f.mode === p.mode));
  } else {
    const copy = {};
    FAV_FIELDS.forEach(k => { if (p[k] !== undefined) copy[k] = p[k]; });
    favs.unshift(copy);
    favs = favs.slice(0, 100);
  }
  safeStorage('set', FAV_KEY, favs);
  refreshFavUi();
  if (state.view === 'saved') renderPlaces();
}

function refreshFavUi() {
  const favs = getFavs();
  els.savedCount.textContent = String(favs.length);
  document.querySelectorAll('[data-fav-id]').forEach(b => {
    const on = favs.some(f => f.id === b.dataset.favId && f.mode === b.dataset.favMode);
    b.setAttribute('aria-pressed', String(on));
    if (b.classList.contains('heart')) b.textContent = on ? '♥' : '♡';
    else b.textContent = on ? '♥ Saved' : '♡ Save';
  });
}

function heartButton(p, className) {
  const b = el('button', {
    type: 'button', class: className, 'data-fav-id': p.id, 'data-fav-mode': p.mode,
    'aria-label': `Save ${p.name}`, 'aria-pressed': 'false',
    onclick: e => { e.stopPropagation(); toggleFav(p); },
    onkeydown: e => e.stopPropagation()
  });
  return b;
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle('saved-view', view === 'saved');
  els.savedBtn.setAttribute('aria-pressed', String(view === 'saved'));
  els.modeTitle.textContent = view === 'saved' ? 'Saved places' : (state.mode === 'nature' ? 'Calm nature spots' : 'Quietest spots');
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

/* Pin icons: a teardrop in the score colour with a symbol for the kind of place. */
const ICONS = [
  [/cafe|coffee|tea/, '☕'], [/restaurant|food|fast_food|bar|pub|ice_cream|bakery/, '🍽'],
  [/park|garden|playground|pitch|recreation|common/, '🌳'], [/forest|wood|nature|reserve|wild/, '🌲'],
  [/water|lake|beach|river|pond|spring|bay/, '💧'], [/viewpoint|peak|view|hill/, '⛰'],
  [/museum|gallery|artwork|attraction|monument|memorial|castle|ruins|temple|place_of_worship|church|mosque/, '🏛'],
  [/library|school|university|college|books/, '📚'], [/shop|supermarket|convenience|clothes|market|mall|store/, '🛍'],
  [/hotel|hostel|guest|camp/, '🛏'], [/hospital|clinic|pharmacy|doctor/, '⚕'], [/fitness|sports|swimming|yoga|gym/, '🏃']
];
function iconFor(p) {
  const c = `${p.category || ''} ${p.group || ''}`.toLowerCase();
  for (const [re, ch] of ICONS) if (re.test(c)) return ch;
  return ({ green: '🌳', wild: '🌲', water: '💧', view: '⛰', shop: '🛍', tourism: '📍', leisure: '🌳', amenity: '📍' })[p.group] || '📍';
}
function pinIcon(p, color, n) {
  const sc = scoreOf(p), tier = sc >= 70 ? 'top' : sc >= 45 ? 'mid' : 'low';
  const html = `<div class="pin pin-${tier}"><svg viewBox="0 0 40 52" width="40" height="52" aria-hidden="true">` +
    `<path d="M20 51C20 51 3 31 3 19a17 17 0 0 1 34 0c0 12-17 32-17 32z" fill="${color}" stroke="#fff" stroke-width="3"/></svg>` +
    `<span class="pin-glyph">${iconFor(p)}</span>${n ? `<span class="pin-num">${n}</span>` : ''}</div>`;
  return L.divIcon({ html, className: 'pin-wrap', iconSize: [40, 52], iconAnchor: [20, 50], popupAnchor: [0, -46], tooltipAnchor: [0, -40] });
}

function initMap() {
  map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);
  markersLayer = (L.markerClusterGroup
    ? L.markerClusterGroup({ maxClusterRadius: 38, showCoverageOnHover: false, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 17 })
    : L.layerGroup()).addTo(map);

  // On-map legend so the colours are explained where you see them.
  const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-legend');
      box.innerHTML = '<div class="lg"><i style="background:#1FA95B"></i><span id="mapLegendHigh"></span></div><div class="lg"><i style="background:#E3A21A"></i><span id="mapLegendMid"></span></div><div class="lg"><i style="background:#E8663D"></i><span id="mapLegendLow"></span></div>';
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  new Legend().addTo(map);

  // The map's box can change after first paint (web fonts, phone toolbars, rotating the device).
  // Leaflet must be told, or markers can be drawn outside the visible area.
  if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize()).observe($('map'));
  window.addEventListener('load', () => map.invalidateSize());
  map.on('popupclose', () => setSelected(null));
  map.on('popupopen', () => { refreshFavUi(); const h = document.getElementById('mapHint'); if (h) h.classList.add('gone'); });

  // Offer "Search this area" once the user pans far from the last search.
  map.on('moveend', () => {
    if (state.programmatic) { state.programmatic = false; return; }
    if (!state.center) return;
    const c = map.getCenter();
    els.searchArea.hidden = haversine(state.center, { lat: c.lat, lon: c.lng }) < state.radius * 0.4;
  });
}

function updateMapLegend() {
  const nature = state.mode === 'nature';
  const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
  set('mapLegendHigh', nature ? 'Very calm' : 'Very quiet');
  set('mapLegendMid', nature ? 'Fairly calm' : 'Fairly quiet');
  set('mapLegendLow', nature ? 'Near busy roads' : 'Busier, well known');
}

/** Highlight the selected place on both the map and the list. */
/** Reveal a marker (expanding its cluster if needed), then run cb. Safe if the marker was removed meanwhile. */
function revealMarker(m, cb) {
  try {
    if (!markersLayer.hasLayer(m)) return;
    if (markersLayer.zoomToShowLayer) markersLayer.zoomToShowLayer(m, cb); else cb();
  } catch (_) { try { cb(); } catch (__) {} }
}

function setSelected(id) {
  if (state.selectedId && state.markers.has(state.selectedId)) {
    const el0 = state.markers.get(state.selectedId).getElement();
    if (el0) el0.classList.remove('pin-selected');
  }
  document.querySelectorAll('.place-card.active').forEach(c => c.classList.remove('active'));
  state.selectedId = id;
  if (id && state.markers.has(id)) {
    const m = state.markers.get(id);
    const apply = () => { const e = m.getElement(); if (e) e.classList.add('pin-selected'); };
    revealMarker(m, apply);
    m.setZIndexOffset(1000);
    const card = document.querySelector(`.place-card[data-id="${CSS.escape(id)}"]`);
    if (card) card.classList.add('active');
  }
}

/** Move without animation. Markers added during a zoom animation can end up misplaced or hidden. */
function jumpTo(lat, lon, zoom) {
  state.programmatic = true;
  map.setView([lat, lon], zoom, { animate: false });
  setTimeout(() => { state.programmatic = false; }, 300);
}

function flyTo(lat, lon, zoom) {
  state.programmatic = true;
  map.flyTo([lat, lon], zoom, { duration: 0.8 });
  // flyTo may not fire moveend if already there; reset the flag shortly after.
  setTimeout(() => { state.programmatic = false; }, 1200);
}

function zoomForRadius(r) {
  return r <= 500 ? 16 : r <= 1000 ? 15 : r <= 2000 ? 14 : r <= 5000 ? 13 : r <= 10000 ? 12 : r <= 25000 ? 11 : r <= 50000 ? 10 : r <= 100000 ? 9 : r <= 200000 ? 8 : 7;
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
      if (first) { jumpTo(lat, lon, 16); }
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
  const source = state.view === 'saved' ? getFavs() : state.places;
  let arr = source.map(p => ({ ...p, _d: distanceOf(p) }));
  if (state.quietOnly && state.view !== 'saved') { const q = arr.filter(p => scoreOf(p) >= 70); if (q.length) arr = q; }
  if (state.sort === 'near' || state.view === 'saved') arr.sort((a, b) => a._d - b._d);
  else arr.sort((a, b) => scoreOf(b) - scoreOf(a) || a.tag_count - b.tag_count);
  return arr;
}

const photoMem = new Map();
function loadPhotos(p, box) {
  const show = list => {
    if (!list.length) { box.remove(); return; }
    box.classList.remove('loading');
    const img = el('img', { alt: `Photo near ${p.name}`, loading: 'lazy', referrerpolicy: 'no-referrer' });
    let i = 0;
    const cap = el('a', { class: 'photo-credit', target: '_blank', rel: 'noopener noreferrer' });
    const set = () => {
      const ph = list[i];
      img.src = ph.url;
      cap.textContent = `${ph.source === 'Google' ? 'Photo: ' : 'Photo near here: '}${ph.credit}${ph.license ? ' · ' + ph.license : ''} · ${ph.source}`;
      if (ph.link) cap.href = ph.link; else cap.removeAttribute('href');
    };
    img.addEventListener('error', () => { if (i < list.length - 1) { i++; set(); } else box.remove(); });
    box.replaceChildren(img, cap);
    if (list.length > 1) box.append(el('button', { type: 'button', class: 'photo-next', text: `Next photo (${list.length})`, onclick: () => { i = (i + 1) % list.length; set(); } }));
    set();
    const pm = map && map._popup; if (pm && pm._updateLayout) { pm._updateLayout(); pm._updatePosition(); pm._adjustPan(); }
  };
  if (photoMem.has(p.id)) { show(photoMem.get(p.id)); return; }
  fetch(`/api/place-photos?lat=${p.lat}&lon=${p.lon}&name=${encodeURIComponent(p.name)}`)
    .then(r => r.json()).then(j => { photoMem.set(p.id, j.photos || []); show(j.photos || []); })
    .catch(err => { console.warn('photo ui failed:', err); box.remove(); });
}

function popupFor(p) {
  const hours = hoursInfo(p);
  const photoBox = el('div', { class: 'photo-box loading', text: 'Loading photo…' });
  loadPhotos(p, photoBox);
  return el('div', {},
    photoBox,
    el('div', { class: 'pop-title', text: p.name }),
    el('div', { class: 'pop-meta' }, el('span', { class: 'cat', text: p.category }), ` · ${formatDistance(p._d)} away`),
    p.mode === 'nature'
      ? el('div', { text: `${scoreLabel(p.calm_score, p.mode)} · ${p.noise_level}` })
      : el('div', { class: 'pop-score', text: scoreLabel(p.silence_score, p.mode) }),
    hours ? el('div', { class: 'pop-hours', text: `${hours.status ? (hours.status.open ? 'Open now' : 'Closed now') + ' · ' + hours.status.detail + ' · ' : ''}${hours.text}` }) : null,
    el('div', { class: 'pop-actions' },
      el('a', { href: directionsUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'Walking directions ↗' }),
      el('button', { type: 'button', class: 'pop-save', text: 'Share', onclick: () => sharePlace(p) }),
      heartButton(p, 'pop-save')),
    el('div', { class: 'pop-links' },
      el('a', { href: osmUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'View on OpenStreetMap ↗' }),
      el('a', { href: osmEditUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'Add or fix info ↗' }))
  );
}

function widenOptions() {
  const radii = [500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 200000, 300000];
  const next = radii.find(r => r > state.radius);
  return next;
}

function showEmpty() {
  if (state.view === 'saved') {
    showMessage('No saved places yet. Tap the heart on a place to keep it here.');
    return;
  }
  const nature = state.placesMode === 'nature';
  const text = nature
    ? 'No named parks, forests or water found here.'
    : 'Nothing unusually quiet turned up here.';
  const next = widenOptions();
  const box = el('div', { class: 'empty-state' }, el('p', { text }));
  if (next) {
    box.append(el('button', {
      type: 'button', text: `Search within ${formatDistance(next)}`,
      onclick: () => { state.radius = next; els.radius.value = String(next); reloadSoon(); }
    }));
  } else {
    const other = nature ? 'quiet' : 'nature';
    box.append(el('button', {
      type: 'button', text: nature ? 'Try Hidden & quiet' : 'Try Nature & calm',
      onclick: () => switchMode(other)
    }));
  }
  box.append(el('p', { text: 'You can also search a different area or move the map and tap “Search this area”.' }));
  els.list.replaceChildren(box);
}

function renderPlaces() {
  markersLayer.clearLayers();
  state.markers.clear();
  state.selectedId = null;
  const places = sortedPlaces();
  els.count.textContent = state.view === 'saved' ? `${places.length} saved` : `${places.length} found`;

  if (!places.length) { showEmpty(); return; }

  const cards = places.map((p, idx) => {
    const score = scoreOf(p);
    const color = scoreColor(score, p.mode);
    const nature = p.mode === 'nature';
    const marker = L.marker([p.lat, p.lon], { icon: pinIcon(p, color, idx + 1), title: p.name, riseOnHover: true, keyboard: true, zIndexOffset: Math.round(score * 10) })
      .bindPopup(() => popupFor(p), { minWidth: 220, maxWidth: 280, autoPanPaddingTopLeft: [10, 70], autoPanPaddingBottomRight: [10, 20] })
      .bindTooltip(p.name, { direction: 'top', offset: [0, -2], className: 'pin-tip' });
    marker.addTo(markersLayer);
    state.markers.set(p.id, marker);

    const open = () => {
      setSelected(p.id);
      flyTo(p.lat, p.lon, 17);
      setTimeout(() => { revealMarker(marker, () => marker.openPopup()); }, 300);
      if (window.matchMedia('(max-width: 820px)').matches) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    marker.on('click', () => {
      setSelected(p.id);
      const c = document.querySelector(`.place-card[data-id="${CSS.escape(p.id)}"]`);
      if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    const why = nature
      ? (p.silence_score >= 80 ? 'Few details online, so it may be a hidden gem.' : 'Well known and documented.')
      : (p.missing && p.missing.length ? `Not recorded: ${p.missing.slice(0, 4).join(', ')}` : 'Fairly well documented');
    const noiseClass = p.noise == null ? 'unknown' : p.noise < 15 ? 'peaceful' : p.noise < 40 ? 'some' : 'busy';
    const hours = hoursInfo(p);
    const stop = e => e.stopPropagation();
    const card = el('div', { class: 'place-card', role: 'button', tabindex: '0', 'data-id': p.id,
        'aria-label': `${p.name}, ${nature ? 'calm' : 'silence'} score ${score}. Show on map.` },
      el('div', { class: 'place-card-top' },
        el('span', { class: 'place-num', style: `background:${color}`, text: String(idx + 1) }),
        el('span', { class: 'place-name', text: p.name }),
        el('span', { class: 'place-score', style: `color:${color}`, text: scoreLabel(score, p.mode) })),
      el('div', { class: 'place-meta' }, el('span', { class: 'cat', text: p.category }), ` · ${formatDistance(p._d)} away`),
      el('div', { class: 'place-why', text: why }),
      el('div', { class: 'place-status' },
        nature ? el('span', { class: `noise ${noiseClass}`, text: p.noise_level }) : null,
        el('span', { class: 'badge', text: scoreLabel(score, p.mode) }),
        hours && hours.status ? el('span', { class: `open-badge ${hours.status.open ? 'open' : 'closed'}`,
          text: `${hours.status.open ? 'Open now' : 'Closed now'} · ${hours.status.detail}` }) : null),
      hours ? el('div', { class: 'place-hours', text: `Hours: ${hours.text}` }) : null,
      hours && hours.tip ? el('div', { class: 'place-tip', text: hours.tip }) : null,
      el('div', { class: 'place-actions' },
        el('a', { href: directionsUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'Directions ↗', onclick: stop, onkeydown: stop }),
        el('button', { type: 'button', class: 'link-btn', text: 'Share', onclick: e => { stop(e); sharePlace(p); }, onkeydown: stop }),
        p.missing && p.missing.length
          ? el('a', { class: 'link-btn', href: osmEditUrl(p), target: '_blank', rel: 'noopener noreferrer', text: 'Add info ↗', onclick: stop, onkeydown: stop })
          : null,
        el('span', { class: 'spacer' }),
        heartButton(p, 'heart'))
    );
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return card;
  });
  els.list.replaceChildren(...cards);
  refreshFavUi();

  fitAll(places);
}

/** Zoom so every result is on screen. Search radius alone can leave pins off-screen on small maps. */
/** Pop up the quietest place so the best result is the first thing seen. */
function openQuietest() {
  const top = sortedPlaces()[0];
  if (!top || scoreOf(top) < 70 || state.selectedId) return;
  const m = state.markers.get(top.id);
  if (!m) return;
  setTimeout(() => {
    if (state.selectedId) return;
    setSelected(top.id);
    revealMarker(m, () => m.openPopup());
  }, 500);
}

function fitAll(places = sortedPlaces()) {
  if (!places.length) return;
  map.invalidateSize();
  state.programmatic = true;
  const pts = places.map(p => [p.lat, p.lon]);
  if (state.user) pts.push([state.user.lat, state.user.lon]);
  map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 17, animate: false });
  setTimeout(() => { state.programmatic = false; }, 600);
}

/* ------------------------------------------------------------------ loading */

function openPendingPlace() {
  const id = state.pendingPlace;
  if (!id) return;
  state.pendingPlace = null;
  const marker = state.markers.get(id);
  const place = state.places.find(p => p.id === id);
  if (!marker || !place) { toast('That shared place is not in the results any more, so the surrounding area is shown.', 6000); return; }
  setSelected(id);
  jumpTo(place.lat, place.lon, 17);
  revealMarker(marker, () => marker.openPopup());
  const card = document.querySelector(`.place-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.scrollIntoView({ block: 'nearest' });
}

function updateUrl() {
  try {
    const u = new URL(location.href);
    u.searchParams.set('lat', state.center.lat.toFixed(5));
    u.searchParams.set('lon', state.center.lon.toFixed(5));
    u.searchParams.set('r', String(state.radius));
    u.searchParams.set('mode', state.mode);
    u.searchParams.delete('place');
    history.replaceState(null, '', u);
  } catch (_) { /* ignore */ }
}

async function loadSilenceMap(lat, lon, label, { keepView = false } = {}) {
  const seq = ++state.loadSeq;
  if (state.view === 'saved') setView('results');
  state.center = { lat, lon };
  state.label = label || state.label;
  els.searchArea.hidden = true;
  els.area.textContent = `${state.label || 'Selected area'} · within ${formatDistance(state.radius)}`;
  if (!keepView) jumpTo(lat, lon, zoomForRadius(state.radius));
  showSkeleton();
  if (state.radius > 10000) toast('Wide search: showing notable quiet places only. This can take up to a minute.', 8000);
  els.count.textContent = '…';
  safeStorage('set', 'silence-map:last', { lat, lon, label: state.label });
  updateUrl();

  let shownEarlier = false, shownPlaces = null;
  try {
    const mode = state.mode;
    const types = mode === 'nature' ? state.natureTypes : state.types;
    const qs = new URLSearchParams({ lat: (+lat).toFixed(3), lon: (+lon).toFixed(3), radius: state.radius, mode, types: [...types].join(',') });
    const ckey = `silence-map:res:${mode}|${(+lat).toFixed(3)}|${(+lon).toFixed(3)}|${state.radius}|${[...types].join(',')}`;
    // Show the last results for this spot instantly, then refresh them in the background.
    const earlier = safeStorage('get', ckey);
    if (earlier && Array.isArray(earlier.places) && Date.now() - earlier.t < 6 * 3600 * 1000) {
      state.placesMode = earlier.mode;
      state.places = earlier.places.map(p => ({ ...p, mode: earlier.mode }));
      updateMapLegend(); renderPlaces(); shownEarlier = true; shownPlaces = earlier.places;
      toast('Showing saved results. Updating…', 3000);
    }

    // Quick first answer: if the full search is slow, ask for a lighter one in parallel and show it at once.
    const getJson = async extra => {
      const r = await fetch(`/api/silence-map?${qs}${extra || ''}`);
      return { res: r, data: await r.json().catch(() => ({})) };
    };
    let fullDone = false;
    const previewTimer = setTimeout(async () => {
      if (shownEarlier || fullDone || seq !== state.loadSeq) return;
      try {
        const p = await getJson('&light=1');
        if (!p.res.ok || fullDone || seq !== state.loadSeq || !(p.data.places || []).length) return;
        state.placesMode = p.data.mode || mode;
        state.places = p.data.places.map(x => ({ ...x, mode: state.placesMode }));
        shownPlaces = p.data.places;
        shownEarlier = true;
        updateMapLegend(); renderPlaces();
        toast('Quick results shown. Loading the rest…', 0);
      } catch (_) { /* the full search is still running */ }
    }, 2500);

    // The free map servers are sometimes busy. Try once more before giving up.
    let res = null, data = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      try { ({ res, data } = await getJson()); } catch (_) { res = null; }
      if (seq !== state.loadSeq) { clearTimeout(previewTimer); return; }   // a newer search replaced this one
      if (res && res.ok) break;
      if (attempt === 0 && (!res || res.status >= 500 || res.status === 429)) {
        if (!shownEarlier) toast('Still searching… the free map servers are slow right now.', 0);
        continue;
      }
      break;
    }
    fullDone = true; clearTimeout(previewTimer);
    if (!res) throw new Error('No connection. Check your internet and try again.');
    if (!res.ok) throw new Error(data.error || 'The server could not process that location.');
    if (!els.toast.hidden && /Still searching|Loading the rest|Updating/.test(els.toast.textContent)) els.toast.hidden = true;

    const sameAsShown = shownEarlier && shownPlaces && shownPlaces.length === data.places.length && shownPlaces.every((p, i) => p.id === data.places[i].id && p.name === data.places[i].name && p.silence_score === data.places[i].silence_score && p.calm_score === data.places[i].calm_score);
    safeStorage('set', ckey, { t: Date.now(), mode: data.mode || mode, places: data.places });
    try {   // keep only the 12 newest saved result sets
      const ks = Object.keys(localStorage).filter(k => k.startsWith('silence-map:res:'))
        .map(k => [k, (JSON.parse(localStorage.getItem(k)) || {}).t || 0]).sort((x, y) => y[1] - x[1]);
      ks.slice(12).forEach(([k]) => localStorage.removeItem(k));
    } catch (_) {}
    state.placesMode = data.mode || mode;
    state.places = data.places.map(p => ({ ...p, mode: state.placesMode }));
    updateMapLegend();
    if (!sameAsShown) renderPlaces();
    if (data.stale) toast('Showing earlier results because the free map servers are busy right now.', 6000);
    else if (state.placesMode === 'nature') {
      if (state.radius > 10000) { /* noise is not checked for wide searches */ }
      else if (data.noise_available === false) toast('Could not check road noise right now, so calm scores are rough estimates.', 6000);
      else if (data.noise_partial) toast('This area is very busy, so the noise estimate may be incomplete. Try a smaller radius.', 6000);
    }
    openPendingPlace();
    if (!state.pendingPlace && state.view !== 'saved') openQuietest();
    if (state.places.length && !safeStorage('get', 'silence-map:pinhint')) { toast('Tap any pin to see the place, its photo and directions.', 6000); safeStorage('set', 'silence-map:pinhint', 1); }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    if (/Still searching|Loading the rest|Updating/.test(els.toast.textContent)) els.toast.hidden = true;
    if (shownEarlier) { toast('Could not update. Showing saved results.', 5000); return; }
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
  if (state.view !== 'saved') els.modeTitle.textContent = nature ? 'Calm nature spots' : 'Quietest spots';
  updateMapLegend();
  els.sortBestOpt.textContent = nature ? 'Calmest first' : 'Quietest first';
  els.legendLow.textContent = nature ? 'Near busy roads' : 'Busier / well known';
  els.legendHigh.textContent = nature ? 'Very calm' : 'Very quiet';
  els.legendText.textContent = nature
    ? 'Green pins are parks, forests and lakes far from busy roads. Amber are okay, orange are close to traffic. The number on a pin matches the number in the list.'
    : 'Green pins are the places the fewest people have written about online, so they are likely quiet and less crowded. Orange are popular, well-known spots. The number on a pin matches the number in the list.';
}

function switchMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  applyMode();
  state.places = [];
  reloadSoon();
}

els.modes.addEventListener('click', e => {
  const btn = e.target.closest('.mode');
  if (btn) switchMode(btn.dataset.mode);
});

els.savedBtn.addEventListener('click', () => {
  if (state.view === 'saved') {
    setView('results');
    if (state.places.length) renderPlaces(); else reloadSoon();
  } else {
    setView('saved');
    renderPlaces();
  }
});

/* ----------------------------------------------------------------- theme */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const light = theme === 'light';
  els.themeBtn.textContent = light ? '☾' : '☀';
  els.themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#FFFFFF' : '#0A0A0C');
}
els.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next);
  safeStorage('set', 'silence-map:theme', next);
});

/* ------------------------------------------------------------ first-visit guide */

const INTRO_KEY = 'silence-map:intro-seen';
function showIntro(show) { els.intro.hidden = !show; }
els.introClose.addEventListener('click', () => { showIntro(false); safeStorage('set', INTRO_KEY, true); });
els.helpBtn.addEventListener('click', () => {
  showIntro(els.intro.hidden);
  if (!els.intro.hidden) els.intro.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

/* ------------------------------------------------------------------- PWA */

let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  els.installBtn.hidden = false;
});
els.installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  els.installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { els.installBtn.hidden = true; });
window.addEventListener('offline', () => toast('You are offline. Saved places still work, but searching needs a connection.', 6000));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

window.addEventListener('pagehide', stopFollow);

/* -------------------------------------------------------------------- start */

setTimeout(() => { const h = document.getElementById('mapHint'); if (h) h.classList.add('gone'); }, 12000);
document.getElementById('quietOnly').addEventListener('change', e => { state.quietOnly = e.target.checked; safeStorage('set', 'silence-map:quietonly', state.quietOnly); renderPlaces(); openQuietest(); });
document.getElementById('fitBtn').addEventListener('click', () => fitAll());

async function start() {
  state.quietOnly = !!safeStorage('get', 'silence-map:quietonly'); document.getElementById('quietOnly').checked = state.quietOnly;
  initMap();
  updateMapLegend();
  refreshFavUi();
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  if (!safeStorage('get', INTRO_KEY)) showIntro(true);

  // 1) a shared link, 2) your last search, 3) your location if already allowed, 4) the default city.
  const params = new URLSearchParams(location.search);
  const qLat = parseFloat(params.get('lat')), qLon = parseFloat(params.get('lon')), qR = parseInt(params.get('r'), 10);
  if ([500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 200000, 300000].includes(qR)) { state.radius = qR; els.radius.value = String(qR); }
  if (params.get('mode') === 'nature') { state.mode = 'nature'; applyMode(); }
  const sharedPlace = params.get('place');
  if (sharedPlace && /^(node|way|relation)\/\d+$/.test(sharedPlace)) state.pendingPlace = sharedPlace;

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
