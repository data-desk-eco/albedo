-- Read from pre-converted Parquet files (see scripts/json_to_parquet.sh)
-- This is much faster than reading JSON directly

select
    '2025-01' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-01.parquet')

union all

select
    '2025-02' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-02.parquet')

union all

select
    '2025-03' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-03.parquet')

union all

select
    '2025-04' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-04.parquet')

union all

select
    '2025-05' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-05.parquet')

union all

select
    '2025-06' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-06.parquet')

union all

select
    '2025-07' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-07.parquet')

union all

select
    '2025-08' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-08.parquet')

union all

select
    '2025-09' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-09.parquet')

union all

select
    '2025-10' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2025-10.parquet')
