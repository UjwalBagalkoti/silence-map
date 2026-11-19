---
name: silence-map
description: Find named places around a user-specified location that have sparse OpenStreetMap documentation, rank them with a transparent metadata-completeness heuristic, and explain the limits of the score.
---

# Silence Map

Use this skill when the user wants to discover lesser-documented places around a named location, compare OpenStreetMap metadata coverage, or create a shortlist of under-documented points of interest.

## Required input

Ask for a place name or city if the user has not supplied one. Ask for a radius only if it materially matters; otherwise use 2,000 metres. Never infer or silently use the user's precise location. Use only a location the user explicitly provides.

## Workflow

1. Explain briefly that this measures **OpenStreetMap documentation sparsity**, not actual quietness, safety, quality, popularity, or lack of visitors.
2. Run the included `silence_map.py` script with the user-provided place and radius. Use Python 3 and the terminal. The script uses only the Python standard library and makes one geocoding request to Nominatim followed by one Overpass query.
3. Use the returned JSON to present up to 20 named places, ordered from highest to lowest silence score. Include each place's name, category, score, tag count, distance, and coordinates.
4. Explain that the score is a simple heuristic: `100 - (tag_count - 2) * 11`, clamped to 0–100. Fewer recorded tags produce a higher score. The result depends on OpenStreetMap coverage and may omit places not mapped there.
5. Do not describe a high score as proof that a place is physically quiet or objectively overlooked. Do not infer that missing tags mean a place lacks facilities or services.
6. If the API returns an error, report it and suggest retrying later. Do not invent results.

## Run

```bash
python silence_map.py --place "Bengaluru, India" --radius 2000 --limit 20
```

The radius must be between 250 and 5,000 metres. The output is JSON on stdout.

## Privacy and network use

- Send only the place string supplied by the user to the public Nominatim geocoder.
- Send the resulting coordinates and radius to the public Overpass API.
- Do not read local files, environment variables, credentials, browser data, or unrelated user data.
- Do not upload, store, or transmit any user files.
- Make requests sequentially; do not parallelize Nominatim requests.
- Identify the client with the User-Agent declared in the script and respect public service availability and usage policies.

## Attribution

Results are derived from OpenStreetMap data. Attribute OpenStreetMap contributors when presenting results and link to https://www.openstreetmap.org/copyright. The score is a project-specific heuristic, not an official OpenStreetMap metric.
