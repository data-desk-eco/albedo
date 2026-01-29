Outstanding Tasks for Albedo

1. ~~Sanctioned vessel dots should replicate raster grid cells~~ DONE

   Sanctioned vessels now export as 0.01° grid cell polygons instead of
   points. The PMTiles layer uses fill geometry so that checking the
   sanctions checkbox overlays red grid cells on the heatmap.
   Changes: export_sanctions_layer.py (polygon export), manifest
   (sanctioned-vessels-fill), main.js (layer id), rebuilt vectors.pmtiles.

2. ~~Improve multi-year color distinction from 2023 blue~~ DONE

   Changed MULTI_YEAR_COLOR from blue (#3D93FF) to neutral grey
   (#A0AAB4) in src/cog.js and updated the legend swatch in index.html.

3. ~~Unify protected area tooltip with vessel tooltip~~ DONE

   Removed the separate #pa-info click panel. Protected area and buffer
   zone info now shows on hover in the shared #tooltip element using the
   same table layout as vessel tooltips. Removed #pa-info HTML, CSS, and
   close-button handler.

4. Upload flag COGs to GCS for production

   Requires gsutil/gcloud credentials and the flag COG files to be
   generated via `make tiles`. Not feasible in this environment. Once
   flag COGs are generated, upload to gs://albedo-data/ and regenerate
   the manifest with the GCS COG_BASE_URL.
