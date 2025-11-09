-- Read from pre-converted Parquet files (see scripts/json_to_parquet.sh)
-- This is much faster than reading JSON directly

select
    '2024-01' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-01.parquet')

union all

select
    '2024-02' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-02.parquet')

union all

select
    '2024-03' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-03.parquet')

union all

select
    '2024-04' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-04.parquet')

union all

select
    '2024-05' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-05.parquet')

union all

select
    '2024-06' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-06.parquet')

union all

select
    '2024-07' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-07.parquet')

union all

select
    '2024-08' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-08.parquet')

union all

select
    '2024-09' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-09.parquet')

union all

select
    '2024-10' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-10.parquet')

union all

select
    '2024-11' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-11.parquet')

union all

select
    '2024-12' as month,
    {{ flatten_vessel_json() }}
from read_parquet('../data/gfw/2024-12.parquet')
