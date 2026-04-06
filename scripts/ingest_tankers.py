#!/usr/bin/env python3
"""
Ingest oil tanker data from LSEG Excel files.

Reads LSEG vessel search exports (data/lseg/*.xlsx), extracts in-service
oil tankers, and joins with GFW vessel data via IMO to produce an enriched
vessel_metadata.json that tags oil tankers.

Each XLSX has a single "Search Results" sheet with columns including:
  IMO, Asset Type, Vessel Status, Vessel Build Year, DWT, Ice Class, Flag

The output vessel_metadata.json has entries like:
  { "273211040": { "imo": "9148580", "y": 1998, "d": 4690, "ot": true } }

where "ot" (oil tanker) is true for vessels matched in the LSEG tanker database.

Usage:
    uv run python scripts/ingest_tankers.py
"""

import json
import os
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("openpyxl is required: uv add openpyxl")
    sys.exit(1)

try:
    import duckdb
except ImportError:
    print("duckdb is required: uv add duckdb")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
LSEG_DIR = ROOT / "data" / "lseg"
DB_PATH = ROOT / "data" / "data.duckdb"
EXPORT_DIR = ROOT / "data" / "export"


def load_lseg_tankers() -> dict[str, dict]:
    """Load all in-service oil tankers from LSEG XLSX files.

    Returns dict keyed by IMO: {imo: {build_year, dwt, asset_type, ice_class}}
    """
    tankers = {}
    xlsx_files = sorted(LSEG_DIR.glob("*.xlsx"))

    if not xlsx_files:
        print(f"No XLSX files found in {LSEG_DIR}")
        sys.exit(1)

    for xlsx_path in xlsx_files:
        print(f"Reading {xlsx_path.name}...")
        wb = openpyxl.load_workbook(xlsx_path, read_only=True)
        ws = wb["Search Results"]

        headers = None
        count = 0
        for row in ws.iter_rows(values_only=True):
            if headers is None:
                headers = [str(h).strip() if h else "" for h in row]
                continue

            d = dict(zip(headers, row))

            # Only in-service vessels
            status = d.get("Vessel Status") or d.get("Status") or ""
            if "SERVICE" not in status.upper():
                continue

            imo = str(d.get("IMO") or "").strip()
            if not imo or not imo.isdigit():
                continue

            build_year = d.get("Vessel Build Year")
            dwt = d.get("DWT (Dead Weight Tonnage)")
            asset_type = d.get("Asset Type")
            ice_class = d.get("Ice Class")

            entry = {"asset_type": asset_type}
            if build_year:
                entry["build_year"] = int(build_year)
            if dwt:
                entry["dwt"] = int(dwt)
            if ice_class and ice_class not in ("No", "None", None):
                entry["ice_class"] = str(ice_class)

            tankers[imo] = entry
            count += 1

        wb.close()
        print(f"  {count} in-service tankers")

    return tankers


def join_with_gfw(tankers: dict[str, dict]) -> dict[str, dict]:
    """Join LSEG tankers with GFW data via IMO to get MMSIs.

    Returns dict keyed by MMSI with merged metadata.
    """
    if not DB_PATH.exists():
        print(f"Database not found: {DB_PATH}")
        print("Run 'make transform' first, or point to main tree DB")
        sys.exit(1)

    con = duckdb.connect(str(DB_PATH), read_only=True)

    # Get IMO→MMSI mapping from GFW (one MMSI per IMO, pick most active)
    rows = con.execute("""
        SELECT imo, mmsi, SUM(hours) as total_hours
        FROM vessel_presence
        WHERE imo IS NOT NULL AND imo != ''
          AND mmsi IS NOT NULL AND mmsi != ''
        GROUP BY imo, mmsi
        ORDER BY imo, total_hours DESC
    """).fetchall()

    # Build IMO→MMSI map (keep the MMSI with most hours per IMO)
    imo_to_mmsi: dict[str, str] = {}
    for imo, mmsi, _ in rows:
        imo = str(imo).strip()
        mmsi = str(mmsi).strip()
        if imo not in imo_to_mmsi:
            imo_to_mmsi[imo] = mmsi

    con.close()

    # Merge: for each LSEG tanker with a matching GFW MMSI, create entry
    result = {}
    matched = 0
    for imo, meta in tankers.items():
        mmsi = imo_to_mmsi.get(imo)
        if not mmsi:
            continue
        matched += 1

        entry = {"imo": imo, "ot": True}  # ot = oil tanker
        if "build_year" in meta:
            entry["y"] = meta["build_year"]
        if "dwt" in meta:
            entry["d"] = meta["dwt"]
        if "ice_class" in meta:
            entry["ic"] = meta["ice_class"]

        result[mmsi] = entry

    print(f"\nLSEG tankers: {len(tankers)}")
    print(f"GFW IMOs: {len(imo_to_mmsi)}")
    print(f"Matched (LSEG tanker → GFW MMSI): {matched}")

    # Age stats
    old = sum(1 for e in result.values() if e.get("y") and 2025 - e["y"] >= 15)
    print(f"Matched & >15 years old: {old}")

    return result


def export_metadata(tanker_meta: dict[str, dict]):
    """Export vessel_metadata.json, merging tanker data with any existing metadata."""
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = EXPORT_DIR / "vessel_metadata.json"

    # Load existing metadata if present
    existing = {}
    if output_path.exists():
        try:
            existing = json.loads(output_path.read_text())
            print(f"\nLoaded {len(existing)} existing metadata entries")
        except Exception:
            pass

    # Merge: tanker data takes priority for matching MMSIs
    merged = dict(existing)
    for mmsi, entry in tanker_meta.items():
        if mmsi in merged:
            merged[mmsi].update(entry)
        else:
            merged[mmsi] = entry

    output_path.write_text(json.dumps(merged, separators=(",", ":")))
    print(f"Exported {len(merged)} entries to {output_path}")
    print(f"  ({len(tanker_meta)} oil tankers, {len(existing)} previous entries)")


if __name__ == "__main__":
    tankers = load_lseg_tankers()
    tanker_meta = join_with_gfw(tankers)
    export_metadata(tanker_meta)
