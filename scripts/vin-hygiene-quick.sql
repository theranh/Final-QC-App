-- VIN hygiene — QUICK REPORT (aggregate counts only, nothing identifying)
-- Read-only. Four queries. Paste the output back to me as-is.
-- Full version with row-level worklists: handoff/vin-hygiene.sql

\echo '=== Q1 — inspections VIN condition ==='
SELECT
  COUNT(*)                                                             AS total_inspections,
  COUNT(*) FILTER (WHERE vin = '')                                     AS vin_empty,
  COUNT(*) FILTER (WHERE vin <> '' AND length(vin) <> 17)               AS vin_wrong_length,
  COUNT(*) FILTER (WHERE vin <> upper(vin))                             AS vin_not_upper,
  COUNT(*) FILTER (WHERE vin <> btrim(vin))                             AS vin_whitespace,
  COUNT(*) FILTER (WHERE vin ~ '[IOQ]')                                 AS vin_illegal_letters,
  COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')  AS vin_malformed_any
FROM inspections;

\echo '=== Q2 — every VIN-keyed table ==='
SELECT 'inspections' AS tbl, COUNT(*) AS rows,
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL) AS blank,
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))) AS needs_normalizing,
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') AS malformed
  FROM inspections
UNION ALL SELECT 'intakes', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM intakes
UNION ALL SELECT 'quote_snapshots', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM quote_snapshots
UNION ALL SELECT 'pricing_corrections', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM pricing_corrections
UNION ALL SELECT 'repair_actuals', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM repair_actuals
UNION ALL SELECT 'vehicle_activity_events', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM vehicle_activity_events
UNION ALL SELECT 'vehicle_handoff_flags', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM vehicle_handoff_flags
UNION ALL SELECT 'production_tracker', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') FROM production_tracker
ORDER BY 1;

\echo '=== Q4 — are blank-VIN inspections recoverable from stock #? ==='
WITH blanks AS (SELECT id, stock FROM inspections WHERE vin = ''),
cand AS (
  SELECT b.id,
         (SELECT COUNT(DISTINCT upper(btrim(i.vin))) FROM intakes i
           WHERE upper(btrim(i.stock)) = upper(btrim(b.stock)) AND i.vin <> '') AS n
    FROM blanks b
)
SELECT CASE WHEN n = 1 THEN 'recoverable — single match'
            WHEN n > 1 THEN 'ambiguous — needs a human'
            ELSE 'unrecoverable — no intake for that stock #' END AS verdict,
       COUNT(*) AS rows
FROM cand GROUP BY 1 ORDER BY 2 DESC;

\echo '=== Q5 — rows that would MERGE if normalized naively (count only) ==='
SELECT COUNT(*) AS colliding_vin_groups FROM (
  SELECT upper(btrim(vin)) FROM inspections WHERE vin <> ''
   GROUP BY 1 HAVING COUNT(DISTINCT vin) > 1
) x;
