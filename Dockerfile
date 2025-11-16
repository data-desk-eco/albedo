FROM python:3.12-slim

WORKDIR /app

# Install GDAL and build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libgdal-dev \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set GDAL environment variables
ENV GDAL_CONFIG=/usr/bin/gdal-config

# Copy and install Python dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

# Copy application code
COPY scripts/ scripts/
COPY index.html .
COPY data/vessel_heatmap.tif data/vessel_heatmap.tif
COPY data/protected_areas.pmtiles data/protected_areas.pmtiles
COPY data/land.pmtiles data/land.pmtiles

# Set environment variables
ENV PORT=8080
ENV PYTHONUNBUFFERED=1

# Expose port
EXPOSE 8080

# Run with gunicorn for production
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "60", "--chdir", "scripts", "tile_server:app"]
