#!/usr/bin/env python3
"""
Fetch sanctioned vessel data from OpenSanctions.
Produces sanctioned_mmsi.json and sanctions_details.json.

OpenSanctions provides structured datasets of sanctioned entities.
We filter for vessels with known IMO identifiers and cross-reference
with our GFW database to get MMSIs.

Usage:
    uv run python scripts/fetch_sanctions.py

Output:
    data/export/sanctioned_mmsi.json     - array of MMSI strings
    data/export/sanctions_details.json   - {mmsi: {programs, datasets}}
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPORT_DIR = ROOT / "data" / "export"
SANCTIONS_DIR = ROOT / "data" / "sanctions"
DB_PATH = ROOT / "data" / "data.duckdb"

# OpenSanctions bulk data URL (simple CSV format)
OPENSANCTIONS_URL = "https://data.opensanctions.org/datasets/latest/default/targets.simple.csv"


def fetch_opensanctions():
    """Fetch OpenSanctions vessel data and extract IMO/MMSI identifiers."""
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

    # Parse CSV for vessel entities
    # The simple CSV format has columns:
    #   id, schema, name, aliases, birth_date, countries, addresses,
    #   identifiers, sanctions, phones, emails, program_ids, dataset,
    #   first_seen, last_seen, last_change
    print("Parsing OpenSanctions data for vessels...")
    sanctioned_by_imo = {}  # imo -> {name, datasets, last_seen}
    sanctioned_by_mmsi = {}  # mmsi -> {name, datasets, last_seen}

    imo_re = re.compile(r"IMO(\d{7})")
    mmsi_re = re.compile(r"MMSI(\d{9})")

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            schema = row.get("schema", "")
            if schema != "Vessel":
                continue

            name = row.get("name", "")
            identifiers = row.get("identifiers", "")
            dataset = row.get("dataset", "")
            last_seen = row.get("last_seen", "")
            sanctions_info = row.get("sanctions", "")

            # Extract IMO numbers from identifiers field
            imos = imo_re.findall(identifiers)
            # Extract MMSI numbers from identifiers field
            mmsis = mmsi_re.findall(identifiers)

            programs_str = name
            if last_seen:
                programs_str = f"{name} - {last_seen[:10]}"

            dataset_list = [d.strip() for d in dataset.split(";") if d.strip()] if dataset else []

            entry = {
                "programs": programs_str,
                "datasets": dataset_list,
            }

            for imo in imos:
                sanctioned_by_imo[imo] = entry

            for mmsi in mmsis:
                if mmsi.isdigit():
                    sanctioned_by_mmsi[mmsi] = entry

    print(f"  Found {len(sanctioned_by_imo)} sanctioned vessels with IMO")
    print(f"  Found {len(sanctioned_by_mmsi)} sanctioned vessels with direct MMSI")

    # Cross-reference IMOs with our vessel database to get MMSIs
    if DB_PATH.exists():
        try:
            import duckdb
            con = duckdb.connect(str(DB_PATH), read_only=True)

            # Get IMO→MMSI mapping
            rows = con.execute("""
                SELECT DISTINCT imo, mmsi
                FROM vessel_presence
                WHERE imo IS NOT NULL AND imo != ''
                  AND mmsi IS NOT NULL AND mmsi != ''
            """).fetchall()
            con.close()

            imo_to_mmsi = {}
            for imo, mmsi in rows:
                imo = str(imo).strip()
                mmsi = str(mmsi).strip()
                if imo not in imo_to_mmsi:
                    imo_to_mmsi[imo] = mmsi

            print(f"  Database has {len(imo_to_mmsi)} IMO→MMSI mappings")

            # Match sanctioned IMOs to MMSIs
            for imo, entry in sanctioned_by_imo.items():
                mmsi = imo_to_mmsi.get(imo)
                if mmsi and mmsi not in sanctioned_by_mmsi:
                    sanctioned_by_mmsi[mmsi] = entry

            print(f"  Total sanctioned vessels with MMSI: {len(sanctioned_by_mmsi)}")

        except Exception as e:
            print(f"  Warning: Could not read database: {e}")
            print("  Only using vessels with direct MMSI identifiers")
    else:
        print("  No database available, only using vessels with direct MMSI identifiers")

    # Write outputs
    mmsi_list = sorted(sanctioned_by_mmsi.keys())
    mmsi_path = EXPORT_DIR / "sanctioned_mmsi.json"
    mmsi_path.write_text(json.dumps(mmsi_list, indent=None))
    print(f"  Wrote {mmsi_path} ({len(mmsi_list)} MMSIs)")

    details_path = EXPORT_DIR / "sanctions_details.json"
    details_path.write_text(json.dumps(sanctioned_by_mmsi, indent=None))
    print(f"  Wrote {details_path}")


if __name__ == "__main__":
    fetch_opensanctions()
