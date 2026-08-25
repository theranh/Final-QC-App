-- VIN hygiene report — Truck Ranch Intake & QC
-- Audit reference: §12 R2, migration phase 3.
--
-- READ-ONLY. Every statement below is a SELECT. Nothing here modifies data.
-- Purpose: size the phase-3 VIN normalization/backfill BEFORE committing to it.
-- Run in order, save the output. Query 9 is the only one that needs a decision from a human.

-- ---------------------------------------------------------------------------
-- 1. Headline: how bad is it?
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*)                                                   AS total_inspections,
  COUNT(*) FILTER (WHERE vin = '')                           AS vin_empty,
  COUNT(*) FILTER (WHERE vin <> '' AND length(vin) <> 17)     AS vin_wrong_length,
  COUNT(*) FILTER (WHERE vin <> upper(vin))                   AS vin_not_upper,
  COUNT(*) FILTER (WHERE vin <> btrim(vin))                   AS vin_has_whitespace,
  COUNT(*) FILTER (WHERE vin ~ '[IOQ]')                       AS vin_has_illegal_letters,
  COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') AS vin_malformed_any
FROM inspections;

-- ---------------------------------------------------------------------------
-- 2. Same check on every other VIN-keyed table (are they actually clean?)
-- ---------------------------------------------------------------------------
SELECT 'intakes' AS tbl, COUNT(*) AS rows,
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL) AS blank,
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))) AS needs_normalizing,
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$') AS malformed
  FROM intakes
UNION ALL SELECT 'quote_snapshots', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')
  FROM quote_snapshots
UNION ALL SELECT 'pricing_corrections', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')
  FROM pricing_corrections
UNION ALL SELECT 'repair_actuals', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')
  FROM repair_actuals
UNION ALL SELECT 'vehicle_activity_events', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')
  FROM vehicle_activity_events
UNION ALL SELECT 'vehicle_handoff_flags', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')
  FROM vehicle_handoff_flags
UNION ALL SELECT 'production_tracker', COUNT(*),
       COUNT(*) FILTER (WHERE vin = '' OR vin IS NULL),
       COUNT(*) FILTER (WHERE vin <> upper(btrim(vin))),
       COUNT(*) FILTER (WHERE vin <> '' AND vin !~ '^[A-HJ-NPR-Z0-9]{17}$')
  FROM production_tracker;

-- ---------------------------------------------------------------------------
-- 3. Is the damage recent or historical? (Drives urgency of the write-path fix.)
-- ---------------------------------------------------------------------------
SELECT date_trunc('month', created_at) AS month,
       COUNT(*) AS inspections,
       COUNT(*) FILTER (WHERE vin = '') AS blank_vin,
       COUNT(*) FILTER (WHERE imported) AS imported_rows
FROM inspections
GROUP BY 1 ORDER BY 1 DESC;

-- ---------------------------------------------------------------------------
-- 4. Blank-VIN rows: are they recoverable from stock #?
--    A recoverable row has exactly one distinct candidate VIN under its stock #.
-- ---------------------------------------------------------------------------
WITH blanks AS (
  SELECT id, qc_number, stock, vehicle, created_at, imported, archived
    FROM inspections WHERE vin = ''
),
cand AS (
  SELECT b.id,
         (SELECT COUNT(DISTINCT upper(btrim(i.vin)))
            FROM intakes i
           WHERE upper(btrim(i.stock)) = upper(btrim(b.stock))
             AND i.vin <> '')                       AS distinct_vins_from_intakes,
         (SELECT MIN(upper(btrim(i.vin)))
            FROM intakes i
           WHERE upper(btrim(i.stock)) = upper(btrim(b.stock))
             AND i.vin <> '')                       AS candidate_vin
    FROM blanks b
)
SELECT CASE
         WHEN distinct_vins_from_intakes = 1 THEN 'recoverable — single match'
         WHEN distinct_vins_from_intakes > 1 THEN 'ambiguous — needs a human'
         ELSE 'unrecoverable — no intake for that stock #'
       END AS verdict,
       COUNT(*) AS rows
FROM cand GROUP BY 1 ORDER BY 2 DESC;

-- 4b. The actual list, for review. Export this; it is the phase-3 worklist.
WITH blanks AS (
  SELECT id, qc_number, stock, vehicle, created_at, imported, archived
    FROM inspections WHERE vin = ''
)
SELECT b.*,
       (SELECT string_agg(DISTINCT upper(btrim(i.vin)), ', ')
          FROM intakes i
         WHERE upper(btrim(i.stock)) = upper(btrim(b.stock))
           AND i.vin <> '') AS candidate_vins
FROM blanks b
ORDER BY b.created_at DESC;

-- ---------------------------------------------------------------------------
-- 5. Case/whitespace collisions: rows that would MERGE once normalized.
--    These are the rows a naive UPDATE would silently collapse. Review first.
-- ---------------------------------------------------------------------------
SELECT upper(btrim(vin)) AS normalized_vin,
       COUNT(*) AS rows,
       COUNT(DISTINCT vin) AS distinct_raw_forms,
       string_agg(DISTINCT vin, ' | ') AS raw_forms
FROM inspections
WHERE vin <> ''
GROUP BY 1
HAVING COUNT(DISTINCT vin) > 1
ORDER BY 2 DESC;

-- ---------------------------------------------------------------------------
-- 6. Cross-module orphans — how much would the Vehicle File actually join today?
-- ---------------------------------------------------------------------------
SELECT
  (SELECT COUNT(DISTINCT upper(btrim(vin))) FROM inspections WHERE vin <> '')      AS vins_in_qc,
  (SELECT COUNT(DISTINCT upper(btrim(vin))) FROM intakes WHERE vin <> '')          AS vins_in_intake,
  (SELECT COUNT(DISTINCT upper(btrim(vin))) FROM quote_snapshots WHERE vin <> '')  AS vins_in_quotes,
  (SELECT COUNT(*) FROM (
      SELECT DISTINCT upper(btrim(vin)) v FROM inspections WHERE vin <> ''
      INTERSECT
      SELECT DISTINCT upper(btrim(vin)) FROM intakes WHERE vin <> ''
   ) x)                                                                            AS vins_in_both_qc_and_intake,
  (SELECT COUNT(*) FROM (
      SELECT DISTINCT upper(btrim(vin)) v FROM inspections WHERE vin <> ''
      EXCEPT
      SELECT DISTINCT upper(btrim(vin)) FROM intakes WHERE vin <> ''
   ) x)                                                                            AS qc_vins_with_no_intake;

-- ---------------------------------------------------------------------------
-- 7. Stock # reuse — a VIN with several stock numbers, or worse, the reverse.
--    Confirms whether vehicle_stock_history (audit §8 step 2) is needed.
-- ---------------------------------------------------------------------------
SELECT upper(btrim(vin)) AS vin, COUNT(DISTINCT upper(btrim(stock))) AS stock_numbers,
       string_agg(DISTINCT upper(btrim(stock)), ', ') AS stocks
FROM inspections WHERE vin <> ''
GROUP BY 1 HAVING COUNT(DISTINCT upper(btrim(stock))) > 1
ORDER BY 2 DESC;

SELECT upper(btrim(stock)) AS stock, COUNT(DISTINCT upper(btrim(vin))) AS vins,
       string_agg(DISTINCT upper(btrim(vin)), ', ') AS vin_list
FROM inspections WHERE vin <> '' AND stock <> ''
GROUP BY 1 HAVING COUNT(DISTINCT upper(btrim(vin))) > 1
ORDER BY 2 DESC;

-- ---------------------------------------------------------------------------
-- 8. ISO 3779 check-digit validation (position 9). Catches transcription typos
--    that pass a length/charset check. North American VINs only — expect a
--    small number of legitimate-looking failures on non-NA vehicles.
-- ---------------------------------------------------------------------------
WITH v AS (
  SELECT id, qc_number, upper(btrim(vin)) AS vin
    FROM inspections
   WHERE vin <> '' AND upper(btrim(vin)) ~ '^[A-HJ-NPR-Z0-9]{17}$'
),
w AS (SELECT * FROM (VALUES
  (1,8),(2,7),(3,6),(4,5),(5,4),(6,3),(7,2),(8,10),
  (9,0),(10,9),(11,8),(12,7),(13,6),(14,5),(15,4),(16,3),(17,2)) AS t(pos, wt)),
val AS (
  SELECT v.id, v.qc_number, v.vin, w.pos, w.wt,
         CASE substr(v.vin, w.pos, 1)
           WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4
           WHEN 'E' THEN 5 WHEN 'F' THEN 6 WHEN 'G' THEN 7 WHEN 'H' THEN 8
           WHEN 'J' THEN 1 WHEN 'K' THEN 2 WHEN 'L' THEN 3 WHEN 'M' THEN 4
           WHEN 'N' THEN 5 WHEN 'P' THEN 7 WHEN 'R' THEN 9
           WHEN 'S' THEN 2 WHEN 'T' THEN 3 WHEN 'U' THEN 4 WHEN 'V' THEN 5
           WHEN 'W' THEN 6 WHEN 'X' THEN 7 WHEN 'Y' THEN 8 WHEN 'Z' THEN 9
           ELSE substr(v.vin, w.pos, 1)::int
         END AS num
    FROM v CROSS JOIN w
),
sums AS (
  SELECT id, qc_number, vin, (SUM(num * wt) % 11) AS remainder
    FROM val GROUP BY id, qc_number, vin
)
SELECT COUNT(*) AS check_digit_failures
FROM sums
WHERE CASE WHEN remainder = 10 THEN 'X' ELSE remainder::text END <> substr(vin, 9, 1);

-- 8b. The failing list, for eyeballing.
--     (Re-run the CTE above and swap the final SELECT for: SELECT id, qc_number, vin FROM sums WHERE ... )

-- ---------------------------------------------------------------------------
-- 9. DECISION REQUIRED — what to do with rows query 4 calls unrecoverable.
--     Options: leave vin = '' and exclude them from vehicle identity (safest);
--     or attach them to a placeholder vehicle record; or have a human resolve
--     each one from the photos/paperwork. Do NOT guess a VIN. Record the choice
--     here before the phase-3 migration is written.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Migration guardrails, once the numbers above are known:
--   * Snapshot the database first.
--   * Fix the WRITE PATH before backfilling, or the problem reappears the next day.
--   * Normalize in a transaction; re-run queries 1 and 5 inside it and compare
--     against the pre-migration output before committing.
--   * Never touch quote_snapshots.doc / rates / content_hash, frozen
--     production_tracker rows, or audit_log — all append-only financial records.
--   * Add the index only after the data is clean.
-- ---------------------------------------------------------------------------
