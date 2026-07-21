#!/usr/bin/env python3
"""Build a privacy-reduced visualization dataset from Google Timeline JSON.

The derived output intentionally omits Google Place IDs and full candidate metadata.
Coordinates are retained at roughly 10 m precision because the local map needs them.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable

JST = dt.timezone(dt.timedelta(hours=9))
MODE_MAP = {
    "in passenger vehicle": "vehicle",
    "in train": "train",
    "flying": "flight",
    "walking": "walking",
    "cycling": "cycling",
    "in bus": "bus",
}
MODE_LABELS = {
    "vehicle": "車",
    "train": "鉄道",
    "flight": "飛行機",
    "walking": "徒歩",
    "cycling": "自転車",
    "bus": "バス",
    "unknown": "未分類",
}


def parse_time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(JST)


def epoch_ms(value: dt.datetime) -> int:
    return int(value.timestamp() * 1000)


def parse_geo(value: str | None) -> tuple[float, float] | None:
    if not value or not value.startswith("geo:"):
        return None
    try:
        lat, lon = value[4:].split(",", 1)
        return round(float(lat), 4), round(float(lon), 4)
    except (ValueError, TypeError):
        return None


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(h)))


def overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def split_hours(start: dt.datetime, end: dt.datetime) -> Iterable[tuple[int, int, float]]:
    cursor = start
    while cursor < end:
        next_hour = (cursor.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1))
        stop = min(end, next_hour)
        yield cursor.weekday(), cursor.hour, (stop - cursor).total_seconds() / 60
        cursor = stop


def anonymized_place_id(place_id: str) -> str:
    return hashlib.sha256(place_id.encode("utf-8")).hexdigest()[:12]


def build(source: Path) -> dict[str, Any]:
    raw = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError("Expected a non-empty top-level JSON array")

    parsed: list[dict[str, Any]] = []
    for index, record in enumerate(raw):
        start = parse_time(record["startTime"])
        end = parse_time(record["endTime"])
        if end < start:
            raise ValueError(f"Record {index} has endTime before startTime")
        kind = "visit" if "visit" in record else "activity" if "activity" in record else "path" if "timelinePath" in record else "unknown"
        if kind == "unknown":
            continue
        parsed.append({"index": index, "start": start, "end": end, "record": record, "kind": kind})

    parsed.sort(key=lambda item: (item["start"], item["end"], item["index"]))
    first = parsed[0]["start"]
    last = max(item["end"] for item in parsed)
    first_ms, last_ms = epoch_ms(first), epoch_ms(last)

    activities: list[dict[str, Any]] = []
    activity_windows: list[tuple[int, int, str]] = []
    rhythm = [[0.0 for _ in range(24)] for _ in range(7)]
    daily_distance: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)

    for item in parsed:
        if item["kind"] != "activity":
            continue
        record = item["record"]["activity"]
        candidate = record.get("topCandidate", {})
        mode = MODE_MAP.get(candidate.get("type", ""), "unknown")
        start_ms, end_ms = epoch_ms(item["start"]), epoch_ms(item["end"])
        distance_km = max(0.0, float(record.get("distanceMeters") or 0) / 1000)
        duration_minutes = max(0.0, (item["end"] - item["start"]).total_seconds() / 60)
        start_geo, end_geo = parse_geo(record.get("start")), parse_geo(record.get("end"))
        speed_kmh = distance_km / (duration_minutes / 60) if duration_minutes else 0
        coarse = duration_minutes > 12 * 60 or (mode == "vehicle" and speed_kmh > 180) or (mode == "walking" and speed_kmh > 12)
        activity = {
            "id": f"A{len(activities) + 1:04d}",
            "start": start_ms,
            "end": end_ms,
            "mode": mode,
            "distanceKm": round(distance_km, 2),
            "durationMinutes": round(duration_minutes, 1),
            "probability": round(float(candidate.get("probability") or 0), 3),
            "startPoint": [start_geo[1], start_geo[0]] if start_geo else None,
            "endPoint": [end_geo[1], end_geo[0]] if end_geo else None,
            "coarse": coarse,
        }
        activities.append(activity)
        activity_windows.append((start_ms, end_ms, mode))
        daily_distance[item["start"].date().isoformat()][mode] += distance_km
        for weekday, hour, minutes in split_hours(item["start"], item["end"]):
            rhythm[weekday][hour] += minutes

    visits: list[dict[str, Any]] = []
    place_groups: dict[str, dict[str, Any]] = {}
    for item in parsed:
        if item["kind"] != "visit":
            continue
        visit = item["record"]["visit"]
        candidate = visit.get("topCandidate", {})
        geo = parse_geo(candidate.get("placeLocation"))
        if not geo:
            continue
        raw_place_id = candidate.get("placeID") or f"coordinate:{geo[0]},{geo[1]}"
        place_key = anonymized_place_id(raw_place_id)
        duration_minutes = max(0.0, (item["end"] - item["start"]).total_seconds() / 60)
        semantic = candidate.get("semanticType") or "Unknown"
        visits.append({
            "id": f"V{len(visits) + 1:04d}",
            "start": epoch_ms(item["start"]),
            "end": epoch_ms(item["end"]),
            "point": [geo[1], geo[0]],
            "durationMinutes": round(duration_minutes, 1),
            "semantic": semantic,
            "placeKey": place_key,
        })
        group = place_groups.setdefault(place_key, {
            "point": [geo[1], geo[0]],
            "count": 0,
            "durationMinutes": 0.0,
            "semantics": collections.Counter(),
            "first": epoch_ms(item["start"]),
            "last": epoch_ms(item["end"]),
        })
        group["count"] += 1
        group["durationMinutes"] += duration_minutes
        group["semantics"][semantic] += 1
        group["first"] = min(group["first"], epoch_ms(item["start"]))
        group["last"] = max(group["last"], epoch_ms(item["end"]))

    frequent_places: list[dict[str, Any]] = []
    ranked_groups = sorted(place_groups.items(), key=lambda pair: (pair[1]["count"], pair[1]["durationMinutes"]), reverse=True)
    place_labels: dict[str, str] = {}
    for rank, (key, group) in enumerate(ranked_groups, 1):
        label = f"P{rank:03d}"
        place_labels[key] = label
        frequent_places.append({
            "id": label,
            "placeKey": key,
            "point": group["point"],
            "visits": group["count"],
            "durationHours": round(group["durationMinutes"] / 60, 1),
            "semantic": group["semantics"].most_common(1)[0][0],
            "first": group["first"],
            "last": group["last"],
        })

    for visit in visits:
        visit["placeId"] = place_labels[visit["placeKey"]]
        del visit["placeKey"]
    for place in frequent_places:
        del place["placeKey"]

    paths: list[dict[str, Any]] = []
    for item in parsed:
        if item["kind"] != "path":
            continue
        start_ms, end_ms = epoch_ms(item["start"]), epoch_ms(item["end"])
        points: list[list[float | int]] = []
        for raw_point in item["record"].get("timelinePath", []):
            geo = parse_geo(raw_point.get("point"))
            if not geo:
                continue
            offset = float(raw_point.get("durationMinutesOffsetFromStartTime") or 0)
            point_ms = start_ms + int(offset * 60_000)
            points.append([geo[1], geo[0], point_ms])
        if not points:
            continue
        mode = "unknown"
        best_overlap = 0
        for act_start, act_end, act_mode in activity_windows:
            candidate_overlap = overlap_ms(start_ms, end_ms, act_start, act_end)
            if candidate_overlap > best_overlap:
                best_overlap, mode = candidate_overlap, act_mode
        path_length = sum(haversine_km((points[i - 1][1], points[i - 1][0]), (points[i][1], points[i][0])) for i in range(1, len(points)))
        paths.append({
            "id": f"R{len(paths) + 1:04d}",
            "start": start_ms,
            "end": end_ms,
            "mode": mode,
            "distanceKm": round(path_length, 2),
            "points": points,
        })

    all_points: list[tuple[float, float]] = []
    all_points.extend((visit["point"][0], visit["point"][1]) for visit in visits)
    for activity in activities:
        if activity["startPoint"]:
            all_points.append(tuple(activity["startPoint"]))
        if activity["endPoint"]:
            all_points.append(tuple(activity["endPoint"]))
    for path in paths:
        all_points.extend((point[0], point[1]) for point in path["points"])
    if not all_points:
        raise ValueError("No coordinates found")

    lons = [point[0] for point in all_points]
    lats = [point[1] for point in all_points]
    bounds = {
        "west": min(lons), "east": max(lons), "south": min(lats), "north": max(lats)
    }

    mode_totals: dict[str, dict[str, float | int]] = {}
    for mode in MODE_LABELS:
        selected = [item for item in activities if item["mode"] == mode]
        if not selected:
            continue
        mode_totals[mode] = {
            "count": len(selected),
            "distanceKm": round(sum(item["distanceKm"] for item in selected), 1),
            "durationHours": round(sum(item["durationMinutes"] for item in selected) / 60, 1),
        }

    months: dict[str, dict[str, Any]] = {}
    for activity in activities:
        month = dt.datetime.fromtimestamp(activity["start"] / 1000, JST).strftime("%Y-%m")
        row = months.setdefault(month, {"distanceKm": 0.0, "durationHours": 0.0, "modes": collections.Counter()})
        row["distanceKm"] += activity["distanceKm"]
        row["durationHours"] += activity["durationMinutes"] / 60
        row["modes"][activity["mode"]] += activity["distanceKm"]
    month_rows = []
    for month in sorted(months):
        row = months[month]
        month_rows.append({
            "month": month,
            "distanceKm": round(row["distanceKm"], 1),
            "durationHours": round(row["durationHours"], 1),
            "modes": {key: round(value, 1) for key, value in row["modes"].items()},
        })

    daily_rows = []
    for day in sorted(daily_distance):
        modes = daily_distance[day]
        daily_rows.append({"date": day, "distanceKm": round(sum(modes.values()), 1), "modes": {k: round(v, 1) for k, v in modes.items()}})

    longest = sorted(activities, key=lambda item: item["distanceKm"], reverse=True)[:20]
    day_count = (last.date() - first.date()).days + 1
    total_distance = sum(item["distanceKm"] for item in activities)
    total_movement_hours = sum(item["durationMinutes"] for item in activities) / 60

    return {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(JST).isoformat(),
        "source": {
            "fileName": source.name,
            "recordCount": len(raw),
            "note": "Derived locally. Google Place IDs and candidate metadata removed; coordinates rounded to ~10 m.",
        },
        "period": {"start": first_ms, "end": last_ms, "days": day_count, "timezone": "Asia/Tokyo"},
        "summary": {
            "records": len(raw),
            "visits": len(visits),
            "activities": len(activities),
            "paths": len(paths),
            "pathPoints": sum(len(path["points"]) for path in paths),
            "uniquePlaces": len(frequent_places),
            "distanceKm": round(total_distance, 1),
            "movementHours": round(total_movement_hours, 1),
        },
        "bounds": bounds,
        "modeLabels": MODE_LABELS,
        "modeTotals": mode_totals,
        "months": month_rows,
        "daily": daily_rows,
        "rhythm": [[round(value, 1) for value in row] for row in rhythm],
        "frequentPlaces": frequent_places,
        "longestJourneys": longest,
        "visits": visits,
        "activities": activities,
        "paths": paths,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--generated-at",
        help="Override generatedAt with a timezone-aware ISO timestamp for reproducible fixtures",
    )
    args = parser.parse_args()
    result = build(args.source)
    if args.generated_at:
        generated_at = dt.datetime.fromisoformat(args.generated_at)
        if generated_at.tzinfo is None:
            parser.error("--generated-at must include an explicit timezone offset")
        result["generatedAt"] = generated_at.isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "bytes": args.output.stat().st_size,
        "periodDays": result["period"]["days"],
        "visits": len(result["visits"]),
        "activities": len(result["activities"]),
        "paths": len(result["paths"]),
        "pathPoints": result["summary"]["pathPoints"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
