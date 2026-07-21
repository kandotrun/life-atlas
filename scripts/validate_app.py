#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "location-data.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    require(payload["schemaVersion"] == 1, "Unexpected schema version")
    require(payload["source"]["recordCount"] == payload["summary"]["records"], "Source record count mismatch")
    require(payload["summary"]["records"] >= payload["summary"]["visits"] + payload["summary"]["activities"] + payload["summary"]["paths"], "Processed record totals exceed source")
    require(payload["summary"]["visits"] == len(payload["visits"]), "Visit count mismatch")
    require(payload["summary"]["activities"] == len(payload["activities"]), "Activity count mismatch")
    require(payload["summary"]["paths"] == len(payload["paths"]), "Path count mismatch")
    require(payload["summary"]["pathPoints"] == sum(len(path["points"]) for path in payload["paths"]), "Path point count mismatch")
    require(payload["period"]["days"] >= 1, "Invalid period length")
    require(all(-180 <= point[0] <= 180 and -90 <= point[1] <= 90 for path in payload["paths"] for point in path["points"]), "Invalid coordinates")

    encoded = DATA.read_text(encoding="utf-8")
    require("ChIJ" not in encoded, "Google Place ID leaked into derived data")
    require('"placeID"' not in encoded, "Raw placeID key leaked into derived data")
    require('"topCandidate"' not in encoded, "Raw candidate metadata leaked into derived data")

    public_files = [ROOT / "index.html", ROOT / "styles.css", ROOT / "app.js"]
    public_text = "\n".join(path.read_text(encoding="utf-8") for path in public_files)
    urls = re.findall(r"https?://[^\"'\s<>]+", public_text)
    allowed_hosts = {"{s}.basemaps.cartocdn.com", "www.openstreetmap.org", "carto.com"}
    external_hosts = {urllib.parse.urlsplit(url).hostname for url in urls}
    require(external_hosts <= allowed_hosts, f"Unexpected external resource host: {external_hosts - allowed_hosts}")
    require("./vendor/leaflet/leaflet-src.esm.js" in public_text, "Local Leaflet module is not loaded")
    require((ROOT / "vendor" / "leaflet" / "leaflet-src.esm.js").exists(), "Leaflet module is missing")
    require((ROOT / "vendor" / "leaflet" / "leaflet.css").exists(), "Leaflet stylesheet is missing")
    require("mapbox" not in public_text.lower(), "External map dependency found")
    require("—" not in public_text and "–" not in public_text, "Disallowed display dash found")

    required_ids = [
        "real-map", "range-start", "range-end", "mode-filters", "month-chart",
        "rhythm-chart", "error-state", "loading",
    ]
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for element_id in required_ids:
        require(f'id="{element_id}"' in html, f"Missing required element: {element_id}")

    print(json.dumps({
        "ok": True,
        "records": payload["summary"]["records"],
        "derivedBytes": DATA.stat().st_size,
        "externalResourceHosts": sorted(host for host in external_hosts if host),
        "rawPlaceIds": 0,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
