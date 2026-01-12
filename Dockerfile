# Build stage - compile frontend
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY index.html vite.config.js ./
COPY src/ src/
RUN yarn build

# Production stage - use ghcr.io rasterio image (includes GDAL + Python + rasterio)
FROM ghcr.io/osgeo/gdal:alpine-small-latest

WORKDIR /app

# Layer 1: System dependencies + Python packages in single layer (cached together)
RUN apk add --no-cache python3 py3-pip gcc g++ python3-dev musl-dev && \
    pip install --no-cache-dir --break-system-packages \
        fastapi uvicorn rio-tiler pillow duckdb && \
    apk del gcc g++ python3-dev musl-dev && \
    rm -rf /root/.cache

# Layer 2: Server code (changes occasionally)
COPY scripts/tile_server.py scripts/tile_server.py

# Layer 3: Data files (changes only when ETL pipeline runs)
COPY data/vessel_heatmap.tif data/vessel_heatmap.tif
COPY data/protected_areas.pmtiles data/protected_areas.pmtiles
COPY data/vessel_crossings.pmtiles data/vessel_crossings.pmtiles
COPY data/land.pmtiles data/land.pmtiles
COPY data/places.pmtiles data/places.pmtiles
COPY data/places/places.json data/places/places.json
# Download vessel lookup database from GitHub release
ADD https://github.com/data-desk-eco/albedo/releases/download/data-v1/vessel_lookup.duckdb data/vessel_lookup.duckdb
COPY data/vessel_categories/ data/vessel_categories/
COPY data/category_*.tif data/

# Layer 4: Frontend (changes most frequently)
COPY --from=builder /app/dist dist/

ENV PORT=8080
ENV PYTHONUNBUFFERED=1
ENV SERVE_DIST=1

EXPOSE 8080

CMD ["uvicorn", "scripts.tile_server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
