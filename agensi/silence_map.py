#!/usr/bin/env python3
"""Rank nearby named OpenStreetMap places by metadata sparsity.

Uses only Python's standard library. Makes one Nominatim request and one
Overpass request. This is an exploratory documentation-coverage heuristic,
not a measure of physical quietness, safety, quality, or popularity.
"""
import argparse
import json
import math
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

USER_AGENT = "SilenceMap-AgensiSkill/1.0 (https://github.com/UjwalBagalkoti/silence-map)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS = "https://overpass-api.de/api/interpreter"


def fetch_json(url, data=None, content_type=None, timeout=40):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError("Public map service returned HTTP " + str(exc.code)) from exc
    except URLError as exc:
        raise RuntimeError("Could not reach public map service: " + str(exc.reason)) from exc
    except TimeoutError as exc:
        raise RuntimeError("Public map service timed out") from exc


def geocode(place):
    payload = fetch_json(NOMINATIM + "?" + urlencode({
        "q": place, "format": "jsonv2", "limit": "1"
    }))
    if not payload:
        raise RuntimeError("No matching location found for: " + place)
    return float(payload[0]["lat"]), float(payload[0]["lon"]), payload[0].get("display_name", place)


def haversine_km(lat1, lon1, lat2, lon2):
    radius = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def query_places(lat, lon, radius):
    around = f"(around:{radius},{lat:.6f},{lon:.6f})"
    clauses = []
    for kind in ("amenity", "shop", "tourism", "leisure"):
        for element in ("node", "way", "relation"):
            clauses.append(f'{element}["name"]["{kind}"]{around};')
    query = "[out:json][timeout:30];(" + "".join(clauses) + ");out center tags;"
    result = fetch_json(OVERPASS, data=query.encode("utf-8"), content_type="text/plain")
    return result.get("elements", [])


def main():
    parser = argparse.ArgumentParser(description="Find lesser-documented OpenStreetMap places.")
    parser.add_argument("--place", required=True, help="User-provided city, area, or place name")
    parser.add_argument("--radius", type=int, default=2000, help="Search radius in metres (250–5000)")
    parser.add_argument("--limit", type=int, default=20, help="Maximum results (1–50)")
    args = parser.parse_args()
    if not 250 <= args.radius <= 5000:
        parser.error("--radius must be between 250 and 5000 metres")
    if not 1 <= args.limit <= 50:
        parser.error("--limit must be between 1 and 50")

    try:
        lat, lon, resolved = geocode(args.place)
        # Nominatim is queried once per run; pause before the separate Overpass request.
        time.sleep(1)
        elements = query_places(lat, lon, args.radius)
        places = []
        seen = set()
        for element in elements:
            tags = element.get("tags") or {}
            name = tags.get("name")
            center = element.get("center") or {}
            item_lat = element.get("lat", center.get("lat"))
            item_lon = element.get("lon", center.get("lon"))
            if not name or item_lat is None or item_lon is None:
                continue
            key = (element.get("type"), element.get("id"))
            if key in seen:
                continue
            seen.add(key)
            tag_count = len(tags)
            score = max(0, min(100, round(100 - (tag_count - 2) * 11)))
            category = next((tags[k] for k in ("amenity", "shop", "tourism", "leisure") if tags.get(k)), "place")
            places.append({
                "name": name,
                "category": category,
                "silence_score": score,
                "tag_count": tag_count,
                "distance_km": round(haversine_km(lat, lon, float(item_lat), float(item_lon)), 2),
                "latitude": float(item_lat),
                "longitude": float(item_lon),
                "has_website": bool(tags.get("website") or tags.get("contact:website")),
                "has_opening_hours": bool(tags.get("opening_hours")),
                "has_phone": bool(tags.get("phone") or tags.get("contact:phone")),
                "has_wikipedia": bool(tags.get("wikipedia") or tags.get("wikidata")),
                "osm_type": element.get("type"),
                "osm_id": element.get("id")
            })
        places.sort(key=lambda p: (-p["silence_score"], p["distance_km"], p["name"].lower()))
        output = {
            "query": args.place,
            "resolved_location": resolved,
            "search_radius_metres": args.radius,
            "result_count": len(places),
            "scoring_method": "max(0, min(100, round(100 - (tag_count - 2) * 11)))",
            "warning": "This score measures OpenStreetMap metadata sparsity only. It does not measure physical quietness, safety, quality, popularity, or visitor numbers.",
            "attribution": "© OpenStreetMap contributors — https://www.openstreetmap.org/copyright",
            "places": places[:args.limit]
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
