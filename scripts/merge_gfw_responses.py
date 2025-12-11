#!/usr/bin/env python3
"""Merge east/west GFW API responses into a single JSON file."""
import json
import sys


def merge(east_file: str, west_file: str, output_file: str) -> None:
    try:
        with open(east_file) as f:
            east = json.load(f)
        with open(west_file) as f:
            west = json.load(f)

        if "error" in east or "error" in west:
            with open(output_file, "w") as f:
                json.dump({"error": "API error in one of the requests"}, f)
            return

        merged = east.copy()
        if (
            "entries" in east
            and "entries" in west
            and east["entries"]
            and west["entries"]
        ):
            east_entries = east["entries"][0]
            west_entries = west["entries"][0]
            for key in west_entries:
                if key in east_entries:
                    east_entries[key].extend(west_entries[key])
                else:
                    east_entries[key] = west_entries[key]

        with open(output_file, "w") as f:
            json.dump(merged, f)

    except Exception as e:
        with open(output_file, "w") as f:
            json.dump({"error": str(e)}, f)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: merge_gfw_responses.py <east.json> <west.json> <output.json>")
        sys.exit(1)
    merge(sys.argv[1], sys.argv[2], sys.argv[3])
