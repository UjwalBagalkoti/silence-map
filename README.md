# Silence Map

Maps the quietest, least-documented places near a location — using **absence of data as the signal**, instead of presence of it.

Created by **UjwalBagalkoti**.

## The idea

Every map app shows you what's popular: top-rated, most-reviewed, most-photographed. Silence Map inverts that. It looks at points of interest on OpenStreetMap and scores each one by how *little* has been recorded about it — no website, no opening hours, no cuisine tag, no Wikipedia link, no wheelchair-access note. Places that score high on the "silence score" are the ones nobody has bothered to document: the corner shop with just a name pin, the park with no metadata, the cafe that exists but has no digital footprint.

It's a small experiment in treating missing data as meaningful rather than as a gap to fill.

## Live Project
https://silence-map.vercel.app/

## Features

- **Live GPS** — "My location" finds quiet spots around you, with a pulsing marker and accuracy ring. **Live** mode follows you as you move and refreshes the list automatically. If location is blocked, it explains how to fix it instead of failing silently.
- **Nature & calm mode** — switch to a second lens that finds parks, gardens, forests, reserves, lakes, beaches and viewpoints, and ranks them by how *calm* they are. The calm score combines distance from busy roads and railways (an estimate from OpenStreetMap data, measured at the centre of each place), how natural the place is, and a small bonus for hidden gems. Each result shows Peaceful, Some traffic noise or Busy road nearby. The estimate does not measure real sound levels, crowds or noise from events.
- **Why it's quiet** — every place shows what is *not* recorded (website, opening hours, phone, wheelchair info…) and a plain-language label from "Well documented" to "Almost invisible".
- **Distance and directions** — see how far each place is and open walking directions in one tap.
- **Radius, type filters and sorting** — 500 m to 5 km, food/shops/sights/parks, quietest-first or nearest-first.
- **Search suggestions** — type a place and pick the right match, with keyboard support.
- **Search this area** — pan the map, then tap one button to look around the new spot.
- **Shareable links** — the URL carries the area and radius, so you can send a view to a friend. It also remembers your last search.
- **Saved places** — tap the heart on any place to keep it. Saved places live on your device (no account), work together with the "Saved" list and are shown on the map.
- **Clear map** — an on-map legend explains the colours, and the place you select is highlighted on both the map and the list.
- **Never a dead end** — if nothing is found, one tap widens the search (or switches mode). Busy map servers are retried automatically and the last good results are shown if they stay busy.
- **First-visit guide** — a short "How it works" card explains the scores. Reopen it any time with the **?** button.
- **Opening hours** — hours recorded on OpenStreetMap are shown, with an "Open now / Closed now" badge when you are near the place, and a tip when a place opens early in the morning. Complex hour formats are shown as text only.
- **Share one place** — a Share button creates a link that opens that exact spot.
- **Improve the map** — each place links to its OpenStreetMap page and editor, so missing details can be added and the data gets better for everyone.
- **Light and dark theme** — follows your device setting and can be switched with the sun/moon button.
- **Install as an app** — works as a Progressive Web App (home-screen icon, full screen). The app shell opens offline; searching needs a connection.
- **Mobile friendly** — map first, list below, large touch targets, no zoom-on-focus on iOS.
- **Safer and faster** — place names are rendered as plain text (OpenStreetMap data is user-contributed), results are cached for 10 minutes, and a backup Overpass server is used if the first is busy.

## How it works

- **Backend** (Node + Express) exposes:
  - `GET /api/geocode?q=<place>` — place name to coordinates via [Nominatim](https://nominatim.org/)
  - `GET /api/silence-map?lat=&lon=&radius=&mode=quiet|nature&types=...` — queries the [Overpass API](https://overpass-api.de/). `mode=quiet` (types `amenity,shop,tourism,leisure`) counts how many OSM tags each named place has and converts that into a 0–100 silence score. `mode=nature` (types `green,wild,water,view`) finds named green and water spaces and scores them for calmness using nearby motorways, main roads and railways
  - `GET /api/health` — simple status check
- **Frontend** is a static Leaflet map with a sidebar list, colour-coded and sized by silence score.

Location is only used in your browser to centre the search. It is sent to the server as plain coordinates for the lookup and is not stored. Browsers only allow location on `https://` pages (or `localhost`).

**No API keys required anywhere** — OpenStreetMap tiles, Nominatim and Overpass are free and open.

## Getting started

Requires Node.js 18 or later (for built-in `fetch`).

```bash
git clone https://github.com/UjwalBagalkoti/silence-map.git
cd silence-map
npm install
cp .env.example .env
npm start
```

Then open `http://localhost:3000`.

## Deploying

This is a single Node service (backend + static frontend together), so it deploys anywhere that runs Node — Render, Railway, Fly.io, a VPS, etc.

Example with Render:
1. Push this repo to GitHub.
2. Create a new **Web Service** on Render, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. No environment variables are required.

## Project structure

```
silence-map/
├── server.js         backend: geocoding + silence-score API
├── package.json
├── .env.example
└── public/
    ├── index.html     app shell
    ├── style.css      dark, low-contrast "absence" theme
    └── app.js         map rendering, search, geolocation
```

## Notes on the scoring

`silence_score = 100 - (tag_count - 2) * 11`, clamped to 0–100. Most OSM points of interest carry at least two tags (a name and one category), so that's the floor. Every additional tag — a phone number, a cuisine, a Wikidata link — pulls the score down. It's a simple heuristic, not a rigorous metric, and it says more about OpenStreetMap's documentation coverage in an area than about how objectively "quiet" a place is in real life.

## Tech

- Node.js + Express
- [Leaflet](https://leafletjs.com/) for the map
- [OpenStreetMap](https://www.openstreetmap.org/), [Nominatim](https://nominatim.org/), and [Overpass API](https://overpass-api.de/) for all data

## v1.6
- Search radius up to 300 km. Beyond 10 km only notable places (parks, reserves, viewpoints, attractions) are searched so the free map servers can answer; road noise is not checked for those searches.

## v1.3
- Big teardrop pins with a symbol per place type, clustering, name labels, auto-zoom to all results, "Show all" button.
- Photos in each place popup: Google Places photos if `GOOGLE_PLACES_API_KEY` is set (needs a Google Cloud project with billing), otherwise freely licensed nearby photos from Wikimedia Commons.
- Leaflet is bundled in `public/vendor` (no third-party CDN needed).

## v2.1
- "Open now only" filter, "Usually calm at this hour" badge, "Share this search" link, Apple Maps directions on iPhone, one-time location prompt on first visit.

## v2.0 – reliable data source
Set `GEOAPIFY_API_KEY` (free key at geoapify.com, ~3000 requests/day) and searches use Geoapify (OpenStreetMap data) for places and place-name search. If the key is missing or Geoapify fails, the app falls back to the free public Overpass/Nominatim servers, which are often overloaded. `GET /api/health` shows whether the keys are configured.
