#!/usr/bin/env python3
"""
Fetch sanctioned vessel data from OpenSanctions.
Produces sanctioned_mmsi.json and sanctions_details.json.

OpenSanctions provides structured datasets of sanctioned entities.
We filter for vessels with known MMSI/IMO identifiers.

Usage:
    uv run python scripts/fetch_sanctions.py

Output:
    data/export/sanctioned_mmsi.json     - array of MMSI strings
    data/export/sanctions_details.json   - {mmsi: {programs, datasets}}
"""

import json
import os
import sys
import urllib.request
import urllib.error
import gzip
import csv
from pathlib import Path
from io import TextIOWrapper

ROOT = Path(__file__).resolve().parent.parent
EXPORT_DIR = ROOT / "data" / "export"
SANCTIONS_DIR = ROOT / "data" / "sanctions"
DB_PATH = ROOT / "data" / "data.duckdb"

# OpenSanctions bulk data URL (statements CSV, gzipped)
# We use the "default" dataset which combines all major sanctions lists
OPENSANCTIONS_URL = "https://data.opensanctions.org/datasets/latest/default/targets.simple.csv"


def fetch_opensanctions():
    """Fetch OpenSanctions vessel data and extract MMSI/IMO identifiers."""
    SANCTIONS_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    csv_path = SANCTIONS_DIR / "targets.simple.csv"

    # Download if not cached (or older than 24h)
    if not csv_path.exists() or (csv_path.stat().st_mtime < (os.path.getmtime(__file__) - 86400) if csv_path.exists() else True):
        print(f"Downloading OpenSanctions data...")
        try:
            req = urllib.request.Request(OPENSANCTIONS_URL, headers={"User-Agent": "albedo/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
                csv_path.write_bytes(data)
            print(f"  Downloaded {len(data)} bytes")
        except urllib.error.URLError as e:
            print(f"  Warning: Could not download OpenSanctions data: {e}")
            if csv_path.exists():
                print("  Using cached data")
            else:
                print("  No cached data available, exiting")
                sys.exit(1)

    # Parse CSV for vessel entities with MMSI
    print("Parsing OpenSanctions data for vessels...")
    sanctioned = {}  # mmsi -> {programs, datasets}

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            schema = row.get("schema", "")
            # Look for Vessel schema or entities with MMSI in properties
            if schema != "Vessel":
                continue

            # Extract identifiers
            props = row.get("properties", "{}")
            try:
                props_dict = json.loads(props) if props else {}
            except json.JSONDecodeError:
                continue

            mmsi_list = props_dict.get("mmsi", [])
            if not mmsi_list:
                continue

            datasets = row.get("datasets", "")
            dataset_list = [d.strip() for d in datasets.split(";") if d.strip()] if datasets else []

            caption = row.get("caption", "")
            first_seen = row.get("first_seen", "")
            last_seen = row.get("last_seen", "")

            for mmsi in mmsi_list:
                mmsi = str(mmsi).strip()
                if not mmsi or not mmsi.isdigit():
                    continue
                programs_str = f"{last_seen}"
                if caption:
                    programs_str = f"{caption} - {programs_str}"

                sanctioned[mmsi] = {
                    "programs": programs_str,
                    "datasets": dataset_list,
                }

    print(f"  Found {len(sanctioned)} sanctioned vessels with MMSI")

    # Cross-reference with our vessel database if available
    known_mmsi = set()
    if DB_PATH.exists():
        try:
            import duckdb
            con = duckdb.connect(str(DB_PATH), read_only=True)
            result = con.execute("SELECT DISTINCT mmsi FROM vessel_activity").fetchall()
            known_mmsi = {str(row[0]) for row in result}
            con.close()
            print(f"  Cross-referencing with {len(known_mmsi)} vessels in database")
        except Exception as e:
            print(f"  Warning: Could not read database: {e}")

    # Filter to only MMSIs we've seen (if database available)
    if known_mmsi:
        matched = {k: v for k, v in sanctioned.items() if k in known_mmsi}
        print(f"  {len(matched)} sanctioned vessels found in our dataset")
    else:
        matched = sanctioned

    # Write outputs
    mmsi_list = sorted(matched.keys())
    mmsi_path = EXPORT_DIR / "sanctioned_mmsi.json"
    mmsi_path.write_text(json.dumps(mmsi_list, indent=None))
    print(f"  Wrote {mmsi_path} ({len(mmsi_list)} MMSIs)")

    details_path = EXPORT_DIR / "sanctions_details.json"
    details_path.write_text(json.dumps(matched, indent=None))
    print(f"  Wrote {details_path}")


if __name__ == "__main__":
    fetch_opensanctions()
