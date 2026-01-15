# Vessel Tooltip Data: Architecture & Optimization

## Current Implementation (v1)

Tile-based binary format with zero JS dependencies.

### Structure
```
data/export/
├── tiles/
│   ├── lookup.bin          # 1.9MB - flags, types, vessels
│   └── {lat}_{lon}.bin     # 7148 gzipped tiles, ~64MB total
```

### Format

**lookup.bin:**
```
[flags_count: u16]
[flags: (len: u8, string: utf8)[]]
[types_count: u16]
[types: (len: u8, string: utf8)[]]
[vessels_count: u32]
[vessels: (mmsi: 12 bytes, name_len: u8, name: utf8)[]]
```

**{lat}_{lon}.bin (gzipped):**
```
[cell_count: u16]
[cells: repeated]
  lat: i16 (×100)
  lon: i16 (×100)
  total_vessels: u16
  vessel_count: u8 (max 5)
  vessels: repeated
    vessel_id: u24
    flag_id: u8
    type_id: u8
    year: u8 (offset from 2020)
    hours: u16
```

### Performance
- **Size:** 64MB tiles + 1.9MB lookup = ~66MB total
- **Init:** 1 fetch (lookup.bin, 1.9MB)
- **Hover:** 1 fetch per 1° tile (~10-50KB each), cached after first hit
- **JS:** ~150 lines, zero dependencies

---

## Planned Optimization (v2)

Hilbert-curve ordered, block-compressed single file.

### Why Hilbert Curve?
- Maps 2D coordinates to 1D while preserving spatial locality
- Cells close in 2D space are close in the 1D ordering
- Better locality preservation than Z-order (Morton) at quadrant boundaries
- When user hovers in a region, nearby cells are in the same block → cache hits

### Structure
```
data/export/
└── vessel_data.bin         # Single file, ~55MB
```

### Format
```
vessel_data.bin:
┌─────────────────────────────────────────────────────────┐
│ Header (16 bytes)                                       │
│   magic: 4 bytes ("VSSL")                               │
│   version: u16                                          │
│   block_count: u16                                      │
│   cell_count: u32                                       │
│   lookup_offset: u32                                    │
├─────────────────────────────────────────────────────────┤
│ Block Index (block_count × 16 bytes)                    │
│   hilbert_start: u32                                    │
│   hilbert_end: u32                                      │
│   offset: u32                                           │
│   compressed_len: u32                                   │
├─────────────────────────────────────────────────────────┤
│ Lookup Tables (~1.9MB)                                  │
│   [flags: count + (len, string)[]]                      │
│   [vessel_types: count + (len, string)[]]               │
│   [vessels: count + (mmsi, name_len, name)[]]           │
├─────────────────────────────────────────────────────────┤
│ Blocks (independently gzip-compressed)                  │
│   [block 0: ~1000 cells sorted by hilbert index]        │
│   [block 1: ~1000 cells sorted by hilbert index]        │
│   ...                                                   │
│   [block N: remaining cells]                            │
└─────────────────────────────────────────────────────────┘
```

### Block Format (before compression)
```
[cell_count: u16]
[cells: repeated, sorted by hilbert index]
  lat: i16 (×100)
  lon: i16 (×100)
  total_vessels: u16
  vessel_count: u8
  vessels: repeated
    vessel_id: u24
    flag_id: u8
    type_id: u8
    year: u8
    hours: u16
```

### Fetch Pattern
```javascript
// Init: range request for header + index + lookup (~2MB)
const headerSize = 16 + (blockCount * 16) + lookupSize
const init = await fetch('vessel_data.bin', {
  headers: { Range: `bytes=0-${headerSize - 1}` }
})

// Hover: range request for block (if not cached)
const hilbert = xyToHilbert(latGrid, lonGrid)
const block = binarySearch(blockIndex, hilbert)

if (!blockCache.has(block.id)) {
  const resp = await fetch('vessel_data.bin', {
    headers: { Range: `bytes=${block.offset}-${block.offset + block.len - 1}` }
  })
  const decompressed = await decompress(resp, 'gzip')
  blockCache.set(block.id, parseBlock(decompressed))
}

return blockCache.get(block.id).get(latLonKey)
```

### Hilbert Curve Implementation
```javascript
// Convert lat/lon to grid coordinates
const latGrid = Math.floor((lat - 50) * 100)  // 0-4000
const lonGrid = Math.floor((lon + 180) * 100) // 0-36000

// Hilbert curve for 16-bit coordinates (order 16)
// Using standard algorithm: rotate and flip quadrants
function xyToHilbert(x, y, order = 16) {
  let d = 0
  for (let s = order / 2; s > 0; s = Math.floor(s / 2)) {
    const rx = (x & s) > 0 ? 1 : 0
    const ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    // Rotate
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y }
      [x, y] = [y, x]
    }
  }
  return d
}
```

### Expected Performance
- **Size:** ~55MB (vs 66MB current) - 17% reduction
- **Init:** 1 range request (~2MB for header + index + lookup)
- **Hover:** 1 range request per block (~15KB compressed, ~1000 cells)
- **Cache:** Spatial locality means panning reuses cached blocks
- **JS:** ~200 lines, zero dependencies

### Why This Is Optimal

1. **Information-theoretic:** Hilbert curve is optimal for preserving 2D locality in 1D
2. **Compression:** Cross-cell compression within blocks (shared dictionary effect)
3. **Caching:** Block granularity matches user behavior (hover in regions)
4. **Simplicity:** Single file, standard HTTP range requests, no special server config
5. **Deployment:** Works on any static host with range request support (GCS, S3, Cloudflare)

### Implementation Steps

1. Add Hilbert curve functions to export script
2. Sort cells by Hilbert index
3. Group into fixed-size blocks (~1000 cells each)
4. Compress each block with gzip
5. Generate block index
6. Concatenate into single file
7. Update JS decoder to:
   - Parse header + index on init
   - Convert lat/lon to Hilbert index on hover
   - Binary search for block
   - Range-request and cache blocks
   - Extract cell from cached block
