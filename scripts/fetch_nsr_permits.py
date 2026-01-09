#!/usr/bin/env python3
"""
Fetch Northern Sea Route vessel permits from Rosatom.
Outputs a list of IMO numbers for vessels permitted to transit the NSR.
"""
import csv
import re
import sys
from pathlib import Path

import requests
from bs4 import BeautifulSoup

NSR_URL = "https://nsr.rosatom.ru/rassmotrenie-zayavleniy/razresheniya/"
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "vessel_categories"


def fetch_permits() -> list[dict]:
    """Scrape vessel permit data from Rosatom NSR website."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; research bot)"}
    response = requests.get(NSR_URL, headers=headers, timeout=30)
    response.raise_for_status()
    response.encoding = "utf-8"

    soup = BeautifulSoup(response.text, "html.parser")
    table = soup.find("table")

    if not table:
        raise ValueError("Permits table not found on page")

    # Get column headers
    thead = table.find("thead")
    if thead:
        headers_row = thead.find("tr")
        columns = [th.get_text(strip=True) for th in headers_row.find_all(["th", "td"])]
    else:
        first_row = table.find("tr")
        columns = [cell.get_text(strip=True) for cell in first_row.find_all(["th", "td"])]

    vessels = []
    tbody = table.find("tbody") or table

    for row in tbody.find_all("tr"):
        if not thead and row == tbody.find("tr"):
            continue  # Skip header row

        cells = row.find_all(["td", "th"])
        if not cells:
            continue

        vessel = {}
        for i, cell in enumerate(cells):
            if i < len(columns):
                header = columns[i]
                # Handle date/file column specially
                if "дата решения" in header.lower() and "файл" in header.lower():
                    date_match = re.match(r"(\d{2}\.\d{2}\.\d{4})", cell.get_text(strip=True))
                    vessel["permit_date"] = date_match.group(1) if date_match else ""
                else:
                    vessel[header] = cell.get_text(strip=True)

        if vessel:
            vessels.append(vessel)

    return vessels


def extract_imos(vessels: list[dict]) -> list[str]:
    """Extract valid IMO numbers from vessel records."""
    imo_column = "Номер ИМО/регистровый или регистрационный номер"
    imos = set()

    for vessel in vessels:
        imo = vessel.get(imo_column, "")
        # Valid IMO numbers are 7 digits
        if imo and len(imo) == 7 and imo.isdigit():
            imos.add(imo)

    return sorted(imos)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Fetching NSR permits from {NSR_URL}...")
    vessels = fetch_permits()
    print(f"Found {len(vessels)} permit records")

    # Save raw permits
    raw_path = OUTPUT_DIR / "nsr_permits_raw.csv"
    if vessels:
        with open(raw_path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=vessels[0].keys())
            writer.writeheader()
            writer.writerows(vessels)
        print(f"Saved raw permits to {raw_path}")

    # Extract and save IMO list
    imos = extract_imos(vessels)
    print(f"Extracted {len(imos)} unique IMO numbers")

    imo_path = OUTPUT_DIR / "nsr_permitted.txt"
    with open(imo_path, "w") as f:
        f.write("\n".join(imos))
    print(f"Saved IMO list to {imo_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
