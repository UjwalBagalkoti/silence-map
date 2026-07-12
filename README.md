# Silence Map

Maps the quietest, least-documented places near a location — using **absence of data as the signal**, instead of presence of it.

Created by **UjwalBagalkoti**.

## The idea

Every map app shows you what's popular: top-rated, most-reviewed, most-photographed. Silence Map inverts that. It looks at points of interest on OpenStreetMap and scores each one by how *little* has been recorded about it — no website, no opening hours, no cuisine tag, no Wikipedia link, no wheelchair-access note. Places that score high on the "silence score" are the ones nobody has bothered to document: the corner shop with just a name pin, the park with no metadata, the cafe that exists but has no digital footprint.

It's a small experiment in treating missing data as meaningful rather than as a gap to fill.

## Demo
https://silence-map.vercel.app/

## How it works

- **Backend** (Node + Express) exposes two endpoints:
  - `GET /api/geocode?q=<place>` — turns a search term into coordinates via [Nominatim](https://nominatim.org/) (OpenStreetMap's free geocoder)
  - `GET /api/silence-map?lat=<n>&lon=<n>&radius=<meters>` — queries the [Overpass API](https://overpass-api.de/) for named points of interest nearby, counts how many OSM tags each one has, and converts that into a 0–100 "silence score" (fewer tags = higher score)
- **Frontend** is a static Leaflet map with a sidebar list, color-coded and sized by silence score.

**No API keys required anywhere** — every data source used (OpenStreetMap tiles, Nominatim, Overpass) is free and open, so the app runs immediately with no signup.

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
