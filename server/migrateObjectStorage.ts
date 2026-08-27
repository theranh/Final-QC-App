import pg from "pg";
import { objectStorage, sha256 } from "./objectStorage";
import { planInspectionAssets, sameJson } from "./storageMigrationData";

type Counts = { total: number; migrated: number; skipped: number; mismatches: string[] };

const started = Date.now();
const report: Record<string, Counts | number> = {
  photos: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  deletedQuotePhotos: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  orientationBackups: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  inspections: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
};

function databaseUrl(): string {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  return process.env.DATABASE_URL;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
  try {
    const deletedResult = await pool.query("SELECT id FROM deleted_quotes");
    const deleted = new Set(deletedResult.rows.map((row) => String(row.id)));

    let photoAfter = "";
    for (;;) {
      const photoResult = await pool.query(
        `SELECT id, quote_id, object_key, sha256 FROM photos
          WHERE id > $1 ORDER BY id LIMIT 100`,
        [photoAfter],
      );
      if (photoResult.rows.length === 0) break;
      for (const row of photoResult.rows) {
        photoAfter = String(row.id);
      const target = deleted.has(String(row.quote_id))
        ? (report.deletedQuotePhotos as Counts)
        : (report.photos as Counts);
      target.total += 1;
      if (deleted.has(String(row.quote_id))) {
        target.skipped += 1;
        continue;
      }
      const id = String(row.id);
      try {
        // Keep the bulk scan metadata-only: fetch exactly one bytea value only
        // when that row is going to be checked or migrated.
        const source = await pool.query("SELECT data FROM photos WHERE id = $1", [id]);
        if (source.rowCount !== 1) throw new Error("source row disappeared during migration");
        const raw = source.rows[0].data;
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const digest = sha256(bytes);
        const key = `photos/${String(row.quote_id)}/${id}`;
        if (row.object_key === key && row.sha256 === digest) {
          try {
            await objectStorage.verify(key, { bytes: bytes.length, sha256: digest });
            target.skipped += 1;
            continue;
          } catch {
            // A missing/corrupt object is repairable from the unchanged bytea.
          }
        }
        await objectStorage.uploadVerified(key, bytes);
        const updated = await pool.query(
          "UPDATE photos SET object_key = $1, sha256 = $2 WHERE id = $3 AND data = $4",
          [key, digest, id, bytes],
        );
        if (updated.rowCount !== 1) throw new Error("source row changed during migration");
        target.migrated += 1;
      } catch (error) {
        target.mismatches.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    }

    const orientation = report.orientationBackups as Counts;
    let orientationAfter = 0;
    for (;;) {
      const orientationResult = await pool.query(
        `SELECT id, object_key, storage_sha256 FROM photo_orientation_backups
          WHERE id > $1 ORDER BY id LIMIT 100`,
        [orientationAfter],
      );
      if (orientationResult.rows.length === 0) break;
      for (const row of orientationResult.rows) {
        orientationAfter = Number(row.id);
      orientation.total += 1;
      const id = String(row.id);
      try {
        const source = await pool.query(
          "SELECT original_data FROM photo_orientation_backups WHERE id = $1",
          [row.id],
        );
        if (source.rowCount !== 1) throw new Error("source row disappeared during migration");
        const raw = source.rows[0].original_data;
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const digest = sha256(bytes);
        const key = `orientation-backups/${id}`;
        if (row.object_key === key && row.storage_sha256 === digest) {
          try {
            await objectStorage.verify(key, { bytes: bytes.length, sha256: digest });
            orientation.skipped += 1;
            continue;
          } catch {
            // A missing/corrupt object is repairable from original_data.
          }
        }
        await objectStorage.uploadVerified(key, bytes);
        const updated = await pool.query(
          "UPDATE photo_orientation_backups SET object_key = $1, storage_sha256 = $2 WHERE id = $3 AND original_data = $4",
          [key, digest, row.id, bytes],
        );
        if (updated.rowCount !== 1) throw new Error("source row changed during migration");
        orientation.migrated += 1;
      } catch (error) {
        orientation.mismatches.push(
          `${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    }

    const inspectionResult = await pool.query(
      `SELECT i.id, i.qc_number, i.data, b.original_data
         FROM inspections i
         LEFT JOIN inspections_data_premigration b ON b.inspection_id = i.id
        ORDER BY i.id`,
    );
    const inspectionCounts = report.inspections as Counts;
    for (const row of inspectionResult.rows) {
      inspectionCounts.total += 1;
      const id = Number(row.id);
      try {
        let source = row.original_data;
        if (source == null) {
          // This durable write intentionally precedes any inspection object or
          // inspections.data write. ON CONFLICT makes interrupted runs safe.
          await pool.query(
            `INSERT INTO inspections_data_premigration (inspection_id, original_data)
             VALUES ($1, $2::jsonb) ON CONFLICT (inspection_id) DO NOTHING`,
            [id, JSON.stringify(row.data)],
          );
          source = row.data;
        }
        const plan = planInspectionAssets(String(row.qc_number), source);
        if (!sameJson(row.data, source) && !sameJson(row.data, plan.data)) {
          throw new Error("current data is neither original nor fully migrated");
        }
        if (sameJson(row.data, plan.data)) {
          try {
            for (const asset of plan.assets) {
              await objectStorage.verify(asset.key, {
                bytes: asset.bytes.length,
                sha256: asset.sha256,
              });
            }
            inspectionCounts.skipped += 1;
            continue;
          } catch {
            // The immutable backup can repair any missing/corrupt object while
            // leaving the already-migrated JSON references unchanged.
          }
          for (const asset of plan.assets) await objectStorage.uploadVerified(asset.key, asset.bytes);
          inspectionCounts.migrated += 1;
          continue;
        }
        for (const asset of plan.assets) await objectStorage.uploadVerified(asset.key, asset.bytes);
        const updated = await pool.query(
          `UPDATE inspections SET data = $1::jsonb
            WHERE id = $2 AND data = $3::jsonb`,
          [JSON.stringify(plan.data), id, JSON.stringify(source)],
        );
        if (updated.rowCount !== 1) throw new Error("source row changed during migration");
        inspectionCounts.migrated += 1;
      } catch (error) {
        inspectionCounts.mismatches.push(
          `${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
  report.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(report, null, 2));
  let mismatchCount = 0;
  for (const value of Object.values(report)) {
    if (typeof value === "object") mismatchCount += value.mismatches.length;
  }
  if (mismatchCount) process.exitCode = 1;
}

main().catch((error) => {
  report.elapsedMs = Date.now() - started;
  console.error(error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});