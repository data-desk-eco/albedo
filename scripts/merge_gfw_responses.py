#!/usr/bin/env python3
"""Merge east and west GFW API responses into a single file."""
import json
import sys

def merge(east_file, west_file, output_file):
    with open(east_file) as f:
        east = json.load(f)
    with open(west_file) as f:
        west = json.load(f)

    # Check for API errors
    for name, data in [("east", east), ("west", west)]:
        if "error" in data or "statusCode" in data:
            print(f"    Error in {name} response: {data.get('error', data.get('messages', [{}])[0].get('title', 'unknown'))}", file=sys.stderr)
            sys.exit(1)

    # Combine entries from both responses
    east_entries = east.get('entries', [])
    west_entries = west.get('entries', [])

    merged = east.copy()
    merged['entries'] = east_entries + west_entries
    merged['total'] = len(merged['entries'])

    with open(output_file, 'w') as f:
        json.dump(merged, f)

    # Count records for logging
    total = sum(len(e.get(list(e.keys())[0], [])) for e in merged['entries'] if e)
    print(f"    Merged {total} records")

if __name__ == '__main__':
    merge(sys.argv[1], sys.argv[2], sys.argv[3])
