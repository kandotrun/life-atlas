#!/usr/bin/env python3
"""Build the strict static-asset allowlist for the Cloudflare Worker."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

FILES = (
    Path("index.html"),
    Path("styles.css"),
    Path("app.js"),
    Path("data/location-data.json"),
    Path("vendor/leaflet/leaflet.css"),
    Path("vendor/leaflet/leaflet-src.esm.js"),
)


def main() -> None:
    if PUBLIC.exists():
        shutil.rmtree(PUBLIC)
    PUBLIC.mkdir(parents=True)

    copied: list[str] = []
    for relative_path in FILES:
        source = ROOT / relative_path
        if not source.is_file():
            raise FileNotFoundError(f"Required public asset is missing: {relative_path}")
        destination = PUBLIC / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied.append(relative_path.as_posix())

    actual = sorted(
        path.relative_to(PUBLIC).as_posix()
        for path in PUBLIC.rglob("*")
        if path.is_file()
    )
    if actual != sorted(copied):
        raise RuntimeError(f"Unexpected files in public build: {actual}")

    print(f"Built {len(actual)} allowlisted public assets in {PUBLIC}")


if __name__ == "__main__":
    main()
