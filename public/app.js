let map, markersLayer;

function initMap(lat, lon){
  if(map){ map.remove(); }
  map = L.map('map', { zoomControl: true }).setView([lat, lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function scoreColor(score){
  // 0 = well documented (muted gray), 100 = practically undocumented (bright violet)
  const t = score / 100;
  const r = Math.round(60 + t * 85);
  const g = Math.round(60 + t * 42);
  const b = Math.round(68 + t * 150);
  return `rgb(${r},${g},${b})`;
}

function renderPlaces(places){
  markersLayer.clearLayers();
  const list = document.getElementById('placeList');
  const count = document.getElementById('resultCount');
  count.textContent = `${places.length} found`;

  if(places.length === 0){
    list.innerHTML = '<p class="empty-state">Nothing unusually quiet turned up here. Try a wider area or a different spot.</p>';
    return;
  }

  list.innerHTML = '';
  places.forEach(p => {
    const color = scoreColor(p.silence_score);
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 6 + p.silence_score / 12,
      fillColor: color,
      fillOpacity: 0.85,
      color: color,
      weight: 1
    }).bindPopup(`<strong>${p.name}</strong><br>${p.category}<br>silence score: ${p.silence_score}`);
    marker.addTo(markersLayer);

    const card = document.createElement('button');
    card.className = 'place-card';
    card.innerHTML = `
      <div class="place-card-top">
        <span class="place-name">${p.name}</span>
        <span class="place-score" style="color:${color}">${p.silence_score}</span>
      </div>
      <div class="place-meta">${p.category} · ${p.tag_count} known facts</div>
    `;
    card.addEventListener('click', () => {
      map.setView([p.lat, p.lon], 17);
      marker.openPopup();
    });
    list.appendChild(card);
  });
}

async function loadSilenceMap(lat, lon){
  initMap(lat, lon);
  const list = document.getElementById('placeList');
  list.innerHTML = '<p class="empty-state">Listening…</p>';
  try{
    const res = await fetch(`/api/silence-map?lat=${lat}&lon=${lon}&radius=2000`);
    if(!res.ok) throw new Error('The server could not process that location.');
    const data = await res.json();
    renderPlaces(data.places);
  }catch(err){
    list.innerHTML = `<p class="empty-state">Could not load data: ${err.message}</p>`;
  }
}

document.getElementById('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if(!q) return;
  const list = document.getElementById('placeList');
  list.innerHTML = '<p class="empty-state">Searching…</p>';
  try{
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    if(!results.length){
      list.innerHTML = '<p class="empty-state">No location found. Try another search.</p>';
      return;
    }
    loadSilenceMap(results[0].lat, results[0].lon);
  }catch(err){
    list.innerHTML = `<p class="empty-state">Search failed: ${err.message}</p>`;
  }
});

document.getElementById('locateBtn').addEventListener('click', () => {
  if(!navigator.geolocation){
    alert('Geolocation is not supported by this browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => loadSilenceMap(pos.coords.latitude, pos.coords.longitude),
    () => alert('Could not get your location. Try searching instead.')
  );
});

// Default view on first load
loadSilenceMap(12.9716, 77.5946);
