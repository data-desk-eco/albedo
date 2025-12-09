-- Read from pre-converted Parquet files with year column
-- Uses glob pattern to read all years dynamically

select
    year,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/*/*.parquet')
