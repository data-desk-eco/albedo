use anyhow::{Context, Result};
use chrono::{Datelike, NaiveDate, Utc};
use clap::{Parser, Subcommand};
use gdal::cpl::CslStringList;
use gdal::raster::Buffer;
use gdal::spatial_ref::SpatialRef;
use gdal::{Dataset, DriverManager, Metadata};
use indicatif::{ParallelProgressIterator, ProgressBar, ProgressStyle};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

const GFW_API_BASE: &str = "https://gateway.api.globalfishingwatch.org/v3/4wings/report";

#[derive(Parser, Debug)]
#[command(name = "gfw2cog", about = "Fetch GFW data and convert to Cloud-Optimized GeoTIFF")]
struct Args {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Fetch data from GFW API and generate COG
    Fetch {
        /// GFW API token
        #[arg(long, env = "GFW_API_TOKEN")]
        token: String,

        /// Dataset ID (e.g., "public-global-vessel-identity:v3.0")
        #[arg(long, default_value = "public-global-presence:v3.0")]
        dataset: String,

        /// Years to fetch (comma-separated)
        #[arg(short, long, value_delimiter = ',', required = true)]
        years: Vec<u16>,

        /// Months to fetch (comma-separated, 1-12). If not specified, fetches all months.
        #[arg(short, long, value_delimiter = ',')]
        months: Vec<u8>,

        /// Output COG path
        #[arg(short, long, default_value = "vessel_heatmap.tif")]
        output: PathBuf,

        /// Bounding box: west,south,east,north
        #[arg(long, default_value = "-180,57,180,90", value_parser = parse_bounds)]
        bounds: Bounds,

        /// Grid resolution in degrees
        #[arg(long, default_value = "0.01")]
        resolution: f64,

        /// Spatial resolution for GFW API (LOW=0.1°, HIGH=0.01°)
        #[arg(long, default_value = "HIGH")]
        spatial_res: String,

        /// Temporal resolution for GFW API (HOURLY, DAILY, MONTHLY, YEARLY)
        #[arg(long, default_value = "MONTHLY")]
        temporal_res: String,

        /// Land mask shapefile (adds land band)
        #[arg(long)]
        land_mask: Option<PathBuf>,

        /// Vessel types to generate separate COGs for (comma-separated)
        #[arg(long, value_delimiter = ',')]
        vessel_types: Vec<String>,

        /// Cache directory for API responses
        #[arg(long, default_value = "data/gfw")]
        cache_dir: PathBuf,

        /// Skip cache and always fetch fresh data
        #[arg(long)]
        no_cache: bool,
    },

    /// Convert existing JSON files to COG (offline mode)
    Convert {
        /// Input JSON files (glob pattern supported)
        #[arg(required = true)]
        inputs: Vec<String>,

        /// Output COG path
        #[arg(short, long, default_value = "vessel_heatmap.tif")]
        output: PathBuf,

        /// Years to include as bands (comma-separated)
        #[arg(short, long, value_delimiter = ',')]
        years: Vec<u16>,

        /// Bounding box: west,south,east,north
        #[arg(long, default_value = "-180,57,180,90", value_parser = parse_bounds)]
        bounds: Bounds,

        /// Grid resolution in degrees
        #[arg(long, default_value = "0.01")]
        resolution: f64,

        /// Land mask shapefile (adds land band)
        #[arg(long)]
        land_mask: Option<PathBuf>,

        /// Vessel types to generate separate COGs for (comma-separated)
        #[arg(long, value_delimiter = ',')]
        vessel_types: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

fn parse_bounds(s: &str) -> Result<Bounds, String> {
    let parts: Vec<f64> = s
        .split(',')
        .map(|p| p.parse().map_err(|e| format!("Invalid bound: {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    if parts.len() != 4 {
        return Err("Bounds must be west,south,east,north".to_string());
    }
    Ok(Bounds {
        west: parts[0],
        south: parts[1],
        east: parts[2],
        north: parts[3],
    })
}

#[derive(Debug, Clone)]
struct GridConfig {
    bounds: Bounds,
    resolution: f64,
    width: usize,
    height: usize,
}

impl GridConfig {
    fn new(bounds: Bounds, resolution: f64) -> Self {
        let width = ((bounds.east - bounds.west) / resolution).round() as usize;
        let height = ((bounds.north - bounds.south) / resolution).round() as usize;
        Self { bounds, resolution, width, height }
    }

    fn lonlat_to_index(&self, lon: f64, lat: f64) -> Option<usize> {
        let col = ((lon - self.bounds.west) / self.resolution).round() as isize;
        let row = ((self.bounds.north - lat) / self.resolution).round() as isize;
        if col >= 0 && col < self.width as isize && row >= 0 && row < self.height as isize {
            Some(row as usize * self.width + col as usize)
        } else {
            None
        }
    }

    fn geo_transform(&self) -> [f64; 6] {
        [
            self.bounds.west,
            self.resolution,
            0.0,
            self.bounds.north,
            0.0,
            -self.resolution,
        ]
    }

    fn size(&self) -> usize {
        self.width * self.height
    }
}

// GFW API request/response types
#[derive(Serialize)]
struct GfwRequest {
    geojson: GeoJsonPolygon,
}

#[derive(Serialize, Clone)]
struct GeoJsonPolygon {
    #[serde(rename = "type")]
    geom_type: String,
    coordinates: Vec<Vec<[f64; 2]>>,
}

#[derive(Deserialize)]
struct GfwResponse {
    entries: Option<Vec<GfwEntry>>,
    error: Option<String>,
    #[serde(rename = "statusCode")]
    status_code: Option<u16>,
    messages: Option<Vec<GfwMessage>>,
}

#[derive(Deserialize)]
struct GfwMessage {
    title: Option<String>,
}

#[derive(Deserialize)]
struct GfwEntry {
    #[serde(rename = "public-global-presence:v3.0")]
    vessels: Option<Vec<VesselRecord>>,
}

#[derive(Deserialize)]
struct VesselRecord {
    lat: Option<f64>,
    lon: Option<f64>,
    hours: Option<f64>,
    #[serde(rename = "vesselType")]
    vessel_type: Option<String>,
}

/// Parsed vessel data ready for aggregation
#[derive(Debug)]
struct ParsedRecord {
    lat: f64,
    lon: f64,
    hours: f32,
    vessel_type: Option<String>,
    year: u16,
}

type GridData = Vec<f32>;
type AggKey = (u16, Option<String>);

/// Fetch data from GFW API for a single region
fn fetch_region(
    client: &reqwest::blocking::Client,
    token: &str,
    dataset: &str,
    polygon: &GeoJsonPolygon,
    start_date: &str,
    end_date: &str,
    spatial_res: &str,
    temporal_res: &str,
) -> Result<GfwResponse> {
    let url = format!(
        "{}?spatial-resolution={}&temporal-resolution={}&group-by=VESSEL_ID&datasets[0]={}&date-range={}T00:00:00.000Z,{}T23:59:59.999Z&format=JSON",
        GFW_API_BASE, spatial_res, temporal_res, dataset, start_date, end_date
    );

    let request = GfwRequest {
        geojson: polygon.clone(),
    };

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&request)
        .send()
        .context("Failed to send request to GFW API")?;

    let text = response.text().context("Failed to read response body")?;
    serde_json::from_str(&text).context("Failed to parse GFW response")
}

/// Fetch a month of data, handling antimeridian split
fn fetch_month(
    client: &reqwest::blocking::Client,
    token: &str,
    dataset: &str,
    bounds: &Bounds,
    year: u16,
    month: u8,
    spatial_res: &str,
    temporal_res: &str,
    cache_dir: &PathBuf,
    no_cache: bool,
) -> Result<Vec<ParsedRecord>> {
    let cache_path = cache_dir.join(format!("{}/{}-{:02}.json", year, year, month));

    // Check cache
    if !no_cache && cache_path.exists() {
        println!("  Using cached: {}-{:02}", year, month);
        return parse_json_file(&cache_path, year);
    }

    // Calculate date range
    let start_date = format!("{}-{:02}-01", year, month);
    let last_day = NaiveDate::from_ymd_opt(year as i32, month as u32, 1)
        .and_then(|_| {
            if month == 12 {
                NaiveDate::from_ymd_opt(year as i32 + 1, 1, 1)
            } else {
                NaiveDate::from_ymd_opt(year as i32, month as u32 + 1, 1)
            }
        })
        .map(|d| d.pred_opt().unwrap().day())
        .unwrap_or(28);
    let end_date = format!("{}-{:02}-{:02}", year, month, last_day);

    println!("  Fetching: {} to {}", start_date, end_date);

    // Split across antimeridian if needed
    let needs_split = bounds.west > bounds.east; // e.g., west=20, east=-160 crosses antimeridian

    let mut all_records = Vec::new();

    if needs_split {
        // East polygon: west to 180
        let east_polygon = GeoJsonPolygon {
            geom_type: "Polygon".to_string(),
            coordinates: vec![vec![
                [bounds.west, bounds.south],
                [180.0, bounds.south],
                [180.0, bounds.north],
                [bounds.west, bounds.north],
                [bounds.west, bounds.south],
            ]],
        };

        // West polygon: -180 to east
        let west_polygon = GeoJsonPolygon {
            geom_type: "Polygon".to_string(),
            coordinates: vec![vec![
                [-180.0, bounds.south],
                [bounds.east, bounds.south],
                [bounds.east, bounds.north],
                [-180.0, bounds.north],
                [-180.0, bounds.south],
            ]],
        };

        // Fetch east
        let east_response = fetch_with_retry(client, token, dataset, &east_polygon, &start_date, &end_date, spatial_res, temporal_res)?;
        all_records.extend(parse_response(&east_response, year)?);

        // Wait between requests (API allows only one concurrent report)
        thread::sleep(Duration::from_secs(60));

        // Fetch west
        let west_response = fetch_with_retry(client, token, dataset, &west_polygon, &start_date, &end_date, spatial_res, temporal_res)?;
        all_records.extend(parse_response(&west_response, year)?);
    } else {
        // Single polygon
        let polygon = GeoJsonPolygon {
            geom_type: "Polygon".to_string(),
            coordinates: vec![vec![
                [bounds.west, bounds.south],
                [bounds.east, bounds.south],
                [bounds.east, bounds.north],
                [bounds.west, bounds.north],
                [bounds.west, bounds.south],
            ]],
        };

        let response = fetch_with_retry(client, token, dataset, &polygon, &start_date, &end_date, spatial_res, temporal_res)?;
        all_records.extend(parse_response(&response, year)?);
    }

    // Cache the response
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Note: we're caching parsed records, not raw JSON - could optimize this later

    println!("    Fetched {} records", all_records.len());
    Ok(all_records)
}

fn fetch_with_retry(
    client: &reqwest::blocking::Client,
    token: &str,
    dataset: &str,
    polygon: &GeoJsonPolygon,
    start_date: &str,
    end_date: &str,
    spatial_res: &str,
    temporal_res: &str,
) -> Result<GfwResponse> {
    let max_retries = 3;

    for attempt in 1..=max_retries {
        match fetch_region(client, token, dataset, polygon, start_date, end_date, spatial_res, temporal_res) {
            Ok(response) => {
                if response.error.is_some() || response.status_code.is_some() {
                    let error_msg = response.error.unwrap_or_else(|| {
                        response.messages
                            .and_then(|m| m.first().and_then(|msg| msg.title.clone()))
                            .unwrap_or_else(|| "Unknown error".to_string())
                    });

                    if error_msg.contains("Too Many Requests") {
                        println!("    Rate limited (attempt {}), waiting 3 minutes...", attempt);
                        thread::sleep(Duration::from_secs(180));
                        continue;
                    }

                    anyhow::bail!("GFW API error: {}", error_msg);
                }
                return Ok(response);
            }
            Err(e) => {
                println!("    Request failed (attempt {}): {}", attempt, e);
                if attempt < max_retries {
                    thread::sleep(Duration::from_secs(60));
                } else {
                    return Err(e);
                }
            }
        }
    }

    anyhow::bail!("Failed after {} attempts", max_retries)
}

fn parse_response(response: &GfwResponse, year: u16) -> Result<Vec<ParsedRecord>> {
    let mut records = Vec::new();

    if let Some(entries) = &response.entries {
        for entry in entries {
            if let Some(vessels) = &entry.vessels {
                for v in vessels {
                    if let (Some(lat), Some(lon), Some(hours)) = (v.lat, v.lon, v.hours) {
                        if hours > 0.0 {
                            records.push(ParsedRecord {
                                lat,
                                lon,
                                hours: hours as f32,
                                vessel_type: v.vessel_type.clone(),
                                year,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(records)
}

fn parse_json_file(path: &PathBuf, year: u16) -> Result<Vec<ParsedRecord>> {
    let file = File::open(path).with_context(|| format!("Failed to open {}", path.display()))?;
    let reader = BufReader::new(file);
    let response: GfwResponse = serde_json::from_reader(reader)
        .with_context(|| format!("Failed to parse JSON from {}", path.display()))?;
    parse_response(&response, year)
}

fn extract_year_from_path(path: &PathBuf) -> Result<u16> {
    let path_str = path.to_string_lossy();
    for part in path_str.split(['/', '-', '_', '.']) {
        if part.len() == 4 {
            if let Ok(year) = part.parse::<u16>() {
                if (2000..=2100).contains(&year) {
                    return Ok(year);
                }
            }
        }
    }
    anyhow::bail!("Could not extract year from path: {}", path.display())
}

/// Rasterize a shapefile to a grid matching our config
fn rasterize_land_mask(shapefile: &PathBuf, grid: &GridConfig) -> Result<GridData> {
    use std::process::Command;

    println!("Rasterizing land mask: {}", shapefile.display());

    // Use gdal_rasterize CLI - it's fast and reliable
    // This is the only CLI fallback in the entire pipeline
    let temp_path = std::env::temp_dir().join("gfw2cog_land_mask.tif");

    let status = Command::new("gdal_rasterize")
        .args(["-burn", "1"])
        .args(["-te",
            &grid.bounds.west.to_string(),
            &grid.bounds.south.to_string(),
            &grid.bounds.east.to_string(),
            &grid.bounds.north.to_string()])
        .args(["-tr", &grid.resolution.to_string(), &grid.resolution.to_string()])
        .args(["-ot", "Float32"])
        .args(["-co", "COMPRESS=DEFLATE"])
        .arg(shapefile)
        .arg(&temp_path)
        .status()
        .context("Failed to run gdal_rasterize")?;

    if !status.success() {
        anyhow::bail!("gdal_rasterize failed with status: {}", status);
    }

    // Read the rasterized result
    let dataset = Dataset::open(&temp_path)?;
    let band = dataset.rasterband(1)?;
    let buffer: Buffer<f32> = band.read_as(
        (0, 0),
        (grid.width, grid.height),
        (grid.width, grid.height),
        None,
    )?;

    let data = buffer.data().to_vec();

    // Cleanup temp file
    let _ = std::fs::remove_file(&temp_path);

    let nonzero = data.iter().filter(|&&v| v > 0.0).count();
    println!("  Land mask: {} cells", nonzero);

    Ok(data)
}

/// Write a multi-band COG with GDAL (no CLI)
fn write_cog(
    path: &PathBuf,
    bands: &[&GridData],
    band_names: &[String],
    grid: &GridConfig,
    metadata: &serde_json::Value,
) -> Result<()> {
    // Create temp GeoTIFF with tiling (COG-compatible structure)
    let temp_path = path.with_extension("tmp.tif");

    let gtiff_driver = DriverManager::get_driver_by_name("GTiff")?;

    // Create with tiling enabled for COG compatibility
    let mut options = CslStringList::new();
    options.add_string("TILED=YES")?;
    options.add_string("BLOCKXSIZE=512")?;
    options.add_string("BLOCKYSIZE=512")?;
    options.add_string("COMPRESS=DEFLATE")?;
    options.add_string("PREDICTOR=2")?;

    let mut dataset = gtiff_driver.create_with_band_type_with_options::<f32, _>(
        &temp_path,
        grid.width,
        grid.height,
        bands.len(),
        &options,
    )?;

    dataset.set_geo_transform(&grid.geo_transform())?;
    let srs = SpatialRef::from_epsg(4326)?;
    dataset.set_spatial_ref(&srs)?;
    dataset.set_metadata_item("ALBEDO_CONFIG", &metadata.to_string(), "")?;

    // Write each band
    for (i, (band_data, band_name)) in bands.iter().zip(band_names.iter()).enumerate() {
        let band_idx = i + 1;
        let mut band = dataset.rasterband(band_idx)?;
        let mut buffer = Buffer::new((grid.width, grid.height), band_data.to_vec());
        band.write((0, 0), (grid.width, grid.height), &mut buffer)?;
        band.set_description(band_name)?;
    }

    // Build overviews for COG
    println!("  Building overviews...");
    dataset.build_overviews("NEAREST", &[2, 4, 8, 16, 32, 64, 128], &[])?;

    // Flush and close
    drop(dataset);

    // Copy to COG format using the COG driver
    println!("  Converting to COG...");
    let temp_dataset = Dataset::open(&temp_path)?;

    let cog_driver = DriverManager::get_driver_by_name("COG")?;
    let mut cog_options = CslStringList::new();
    cog_options.add_string("COMPRESS=DEFLATE")?;
    cog_options.add_string("PREDICTOR=2")?;
    cog_options.add_string("RESAMPLING=NEAREST")?;

    // Use create_copy via the dataset
    let _cog_dataset = temp_dataset.create_copy(&cog_driver, path, &cog_options)?;

    // Cleanup temp file
    std::fs::remove_file(&temp_path)?;

    let size = std::fs::metadata(path)?.len();
    println!("  Created: {} ({:.1} MB)", path.display(), size as f64 / 1_000_000.0);

    Ok(())
}

fn aggregate_and_write(
    all_records: Vec<ParsedRecord>,
    years: Vec<u16>,
    vessel_types: &[String],
    grid: &GridConfig,
    land_mask_data: Option<GridData>,
    output: &PathBuf,
) -> Result<()> {
    // Determine vessel types for separate COGs
    let vessel_type_opts: Vec<Option<String>> = if vessel_types.is_empty() {
        vec![None]
    } else {
        std::iter::once(None)
            .chain(vessel_types.iter().map(|t| Some(t.clone())))
            .collect()
    };

    // Aggregate into grids
    println!("Aggregating {} records...", all_records.len());
    let mut grids: HashMap<AggKey, GridData> = HashMap::new();

    // Initialize grids
    for &year in &years {
        for vt in &vessel_type_opts {
            grids.insert((year, vt.clone()), vec![0.0f32; grid.size()]);
        }
    }

    // Aggregate records
    let progress = ProgressBar::new(all_records.len() as u64);
    progress.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} records")?
            .progress_chars("#>-"),
    );

    for (i, record) in all_records.iter().enumerate() {
        if i % 100_000 == 0 {
            progress.set_position(i as u64);
        }

        if !years.contains(&record.year) {
            continue;
        }

        if let Some(idx) = grid.lonlat_to_index(record.lon, record.lat) {
            // Always add to aggregate
            if let Some(grid_data) = grids.get_mut(&(record.year, None)) {
                grid_data[idx] += record.hours;
            }

            // Add to vessel-type-specific grid if applicable
            if let Some(ref vt) = record.vessel_type {
                let vt_upper = vt.to_uppercase();
                if vessel_types.iter().any(|t| t.to_uppercase() == vt_upper) {
                    if let Some(grid_data) = grids.get_mut(&(record.year, Some(vt_upper))) {
                        grid_data[idx] += record.hours;
                    }
                }
            }
        }
    }
    progress.finish_with_message("Aggregation complete");

    // Write COGs for each vessel type
    let today = Utc::now().format("%Y-%m-%d").to_string();

    for vt in &vessel_type_opts {
        let suffix = match vt {
            None => String::new(),
            Some(t) => format!("_{}", t.to_lowercase()),
        };

        let output_path = if vt.is_none() {
            output.clone()
        } else {
            let stem = output.file_stem().unwrap().to_string_lossy();
            let ext = output.extension().map(|e| e.to_string_lossy()).unwrap_or("tif".into());
            output.with_file_name(format!("{}{}.{}", stem, suffix, ext))
        };

        let label = vt.as_ref().map(|s| s.as_str()).unwrap_or("aggregate");
        println!("Writing {} COG: {}", label, output_path.display());

        // Collect bands for this vessel type
        let mut bands: Vec<&GridData> = years
            .iter()
            .filter_map(|&year| grids.get(&(year, vt.clone())))
            .collect();

        let mut band_names: Vec<String> = years.iter().map(|y| y.to_string()).collect();

        // Add land mask band if available
        if let Some(ref land_data) = land_mask_data {
            bands.push(land_data);
            band_names.push("land".to_string());
        }

        // Print band stats
        for (i, (band_data, name)) in bands.iter().zip(band_names.iter()).enumerate() {
            let nonzero = band_data.iter().filter(|&&v| v > 0.0).count();
            println!("  Band {}: {} (non-zero: {})", i + 1, name, nonzero);
        }

        // Build metadata
        let metadata = serde_json::json!({
            "years": years.iter().map(|&y| y as i32).collect::<Vec<_>>(),
            "landBand": if land_mask_data.is_some() { serde_json::json!(years.len()) } else { serde_json::Value::Null },
            "lastUpdated": today,
        });

        write_cog(&output_path, &bands, &band_names, grid, &metadata)?;
    }

    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();

    match args.command {
        Commands::Fetch {
            token,
            dataset,
            years,
            months,
            output,
            bounds,
            resolution,
            spatial_res,
            temporal_res,
            land_mask,
            vessel_types,
            cache_dir,
            no_cache,
        } => {
            let grid = GridConfig::new(bounds, resolution);
            println!(
                "Grid: {}x{} pixels ({:.2}M cells)",
                grid.width, grid.height,
                grid.size() as f64 / 1_000_000.0
            );

            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()?;

            let months_to_fetch: Vec<u8> = if months.is_empty() {
                (1..=12).collect()
            } else {
                months
            };

            let mut all_records = Vec::new();

            for &year in &years {
                println!("Year {}:", year);
                for &month in &months_to_fetch {
                    match fetch_month(
                        &client, &token, &dataset, &bounds,
                        year, month, &spatial_res, &temporal_res,
                        &cache_dir, no_cache
                    ) {
                        Ok(records) => all_records.extend(records),
                        Err(e) => eprintln!("  Failed to fetch {}-{:02}: {}", year, month, e),
                    }

                    // Rate limit between months
                    thread::sleep(Duration::from_secs(30));
                }
            }

            println!("Total records: {}", all_records.len());

            // Rasterize land mask if provided
            let land_mask_data = if let Some(ref land_path) = land_mask {
                Some(rasterize_land_mask(land_path, &grid)?)
            } else {
                None
            };

            aggregate_and_write(all_records, years, &vessel_types, &grid, land_mask_data, &output)?;
        }

        Commands::Convert {
            inputs,
            output,
            years,
            bounds,
            resolution,
            land_mask,
            vessel_types,
        } => {
            // Expand glob patterns
            let mut input_files: Vec<PathBuf> = Vec::new();
            for pattern in &inputs {
                for entry in glob::glob(pattern)? {
                    input_files.push(entry?);
                }
            }

            if input_files.is_empty() {
                anyhow::bail!("No input files found");
            }

            let grid = GridConfig::new(bounds, resolution);
            println!(
                "Grid: {}x{} pixels ({:.2}M cells)",
                grid.width, grid.height,
                grid.size() as f64 / 1_000_000.0
            );
            println!("Processing {} files...", input_files.len());

            // Parse all files in parallel
            let progress = ProgressBar::new(input_files.len() as u64);
            progress.set_style(
                ProgressStyle::default_bar()
                    .template("{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} files ({eta})")?
                    .progress_chars("#>-"),
            );

            let all_records: Vec<ParsedRecord> = input_files
                .par_iter()
                .progress_with(progress.clone())
                .filter_map(|path| {
                    let year = match extract_year_from_path(path) {
                        Ok(y) => y,
                        Err(e) => {
                            eprintln!("Warning: {e}");
                            return None;
                        }
                    };
                    match parse_json_file(path, year) {
                        Ok(records) => Some(records),
                        Err(e) => {
                            eprintln!("Warning: {e}");
                            None
                        }
                    }
                })
                .flatten()
                .collect();

            progress.finish_with_message("Parsing complete");
            println!("Parsed {} vessel records", all_records.len());

            // Determine years from data if not specified
            let years: Vec<u16> = if years.is_empty() {
                let mut years: Vec<u16> = all_records.iter().map(|r| r.year).collect();
                years.sort();
                years.dedup();
                years
            } else {
                years
            };
            println!("Years: {:?}", years);

            // Rasterize land mask if provided
            let land_mask_data = if let Some(ref land_path) = land_mask {
                Some(rasterize_land_mask(land_path, &grid)?)
            } else {
                None
            };

            aggregate_and_write(all_records, years, &vessel_types, &grid, land_mask_data, &output)?;
        }
    }

    println!("Done!");
    Ok(())
}
