#!/usr/bin/env python3
"""Check PMTiles metadata"""
from pmtiles.reader import Reader, MmapSource

with open('data/tiles.pmtiles', 'rb') as f:
    reader = Reader(MmapSource(f))
    metadata = reader.metadata()
    print(f"minzoom: {metadata.get('minzoom')}")
    print(f"maxzoom: {metadata.get('maxzoom')}")
    print(f"Metadata: {metadata}")
