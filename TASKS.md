Outstanding Tasks for Albedo

1. Sanctioned vessel dots should replicate raster grid cells

   The sanctioned vessels PMTiles layer currently renders as circle points
   (red dots) that sit at the top-left corner of each raster grid cell.
   Instead, these should be rendered as fill-extrusion or fill rectangles
   that exactly cover the 0.01° grid cell, effectively recoloring the
   heatmap pixel red for sanctioned vessel positions. This requires
   changing the sanctioned_vessels layer from circle to fill geometry —
   either export grid-cell polygons instead of points in
   export_sanctions_layer.py, or use a client-side approach to snap
   circles to grid cells. The goal is that when the checkbox is checked,
   sanctioned vessel grid cells turn red, overlaying the existing heatmap.

2. Improve multi-year color distinction from 2023 blue

   The "multiple years" blend color (used when no single year dominates a
   grid cell) is currently a blue (#3D93FF) that is hard to distinguish
   from the 2023 year color (#2988FF). Change the multi-year color to a
   neutral grey so it is visually distinct from all individual year colors.
   This affects MULTI_YEAR_COLOR in src/cog.js and the corresponding
   legend swatch in the UI.

3. Upload flag COGs to GCS for production

   Per-flag COG heatmaps (vessel_heatmap_flag_*.tif) have been generated
   locally but are not yet uploaded to the GCS bucket
   (gs://albedo-data/). The production manifest uses COG_BASE_URL pointing
   to GCS, so flag filtering will not work in production until these files
   are uploaded. After uploading, regenerate the manifest with the GCS
   COG_BASE_URL and verify flag switching works from the deployed site.
