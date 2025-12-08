# Build stage - compile frontend
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY index.html vite.config.js ./
COPY src/ src/
RUN yarn build

# Production stage
FROM python:3.12-slim

WORKDIR /app

# Install system dependencies (rarely changes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libgdal-dev \
    g++ \
    && rm -rf /var/lib/apt/lists/*

ENV GDAL_CONFIG=/usr/bin/gdal-config

# Install Python dependencies (changes occasionally)
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

# Copy static data files (changes occasionally)
COPY data/vessel_heatmap.tif data/vessel_heatmap.tif
COPY data/protected_areas.pmtiles data/protected_areas.pmtiles
COPY data/vessel_crossings.pmtiles data/vessel_crossings.pmtiles
COPY data/land.pmtiles data/land.pmtiles
COPY data/places.pmtiles data/places.pmtiles

# Copy built frontend from builder stage
COPY --from=builder /app/dist dist/

# Copy application code (changes most frequently)
COPY scripts/ scripts/

# Set environment variables
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
ENV SERVE_DIST=1

# Expose port
EXPOSE 8080

# Run with gunicorn for production
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "60", "--chdir", "scripts", "tile_server:app"]
