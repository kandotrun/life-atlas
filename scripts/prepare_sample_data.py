#!/usr/bin/env python3
"""Copy the public synthetic dataset into the ignored local runtime path."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "location-data.example.json"
DESTINATION = ROOT / "data" / "location-data.json"


def main() -> None:
    if DESTINATION.exists():
        print(f"Keeping existing {DESTINATION}; no data was overwritten")
        return
    if not SOURCE.exists():
        raise FileNotFoundError(f"Missing synthetic sample: {SOURCE}")
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, DESTINATION)
    print(f"Prepared synthetic runtime data at {DESTINATION}")


if __name__ == "__main__":
    main()
