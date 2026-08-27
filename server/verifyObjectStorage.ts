import pg from "pg";
import { objectStorage, sha256 } from "./objectStorage";
import { planInspectionAssets, sameJson } from "./storageMigrationData";

type Counts = { total: number; migrated: number; skipped: number; mismatches: string[] };
type ObjectKeyCount = { expected: number; actual: number };

const started = Date.now();
const report: Record<string, Counts | number | boolean | ObjectKeyCount> = {
  photos: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  deletedQuotePhotos: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  orientationBackups: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  inspections: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    let photoAfter = "";
    for (;;) {
      const photoResult = await pool.query(
        `SELECT p.id, p.quote_id, p.object_key, p.sha256,
                (d.id IS NOT NULL) AS deleted
           FROM photos p LEFT JOIN deleted_quotes d ON d.id = p.quote_id
          WHERE p.id > $1 ORDER BY p.id LIMIT 100`,
        [photoAfter],
      );
      if (photoResult.rows.length === 0) break;
      for (const row of photoResult.rows) {
        photoAfter = String(row.id);
      if (row.deleted) {
        const deleted = report.deletedQuotePhotos as Counts;
        deleted.total += 1;
        deleted.skipped += 1;
        continue;
      }
      const counts = report.photos as Counts;
      counts.total += 1;
      const id = String(row.id);
      try {
        const source = await pool.query("SELECT data FROM photos WHERE id = $1", [id]);
        if (source.rowCount !== 1) throw new Error("source row disappeared during verification");
        const raw = source.rows[0].data;
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const digest = sha256(bytes);
        const key = `photos/${String(row.quote_id)}/${id}`;
        if (row.object_key !== key) throw new Error(`object_key is ${String(row.object_key)}`);
        if (row.sha256 !== digest) throw new Error(`database sha256 is ${String(row.sha256)}`);
        await objectStorage.verify(key, { bytes: bytes.length, sha256: digest });
        counts.skipped += 1;
      } catch (error) {
        counts.mismatches.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    }

    // This explicit count makes the expected active-photo coverage visible in
    // the report, independently of per-row read-back/hash checks above.
    const photos = report.photos as Counts;
    const activeObjectKeys = await pool.query(
      `SELECT count(*) FILTER (WHERE d.id IS NULL)::int AS expected,
              count(*) FILTER (WHERE d.id IS NULL AND p.object_key IS NOT NULL)::int AS actual
         FROM photos p LEFT JOIN deleted_quotes d ON d.id = p.quote_id`,
    );
    const coverage: ObjectKeyCount = activeObjectKeys.rows[0];
    report.activePhotoObjectKeys = coverage;
    if (coverage.actual !== coverage.expected || coverage.expected !== photos.total) {
      photos.mismatches.push(
        `active photo object_key count expected ${coverage.expected}, got ${coverage.actual}`,
      );
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
        if (source.rowCount !== 1) throw new Error("source row disappeared during verification");
        const raw = source.rows[0].original_data;
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const digest = sha256(bytes);
        const key = `orientation-backups/${id}`;
        if (row.object_key !== key) throw new Error(`object_key is ${String(row.object_key)}`);
        if (row.storage_sha256 !== digest) {
          throw new Error(`database storage_sha256 is ${String(row.storage_sha256)}`);
        }
        await objectStorage.verify(key, { bytes: bytes.length, sha256: digest });
        orientation.skipped += 1;
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
    const inspections = report.inspections as Counts;
    for (const row of inspectionResult.rows) {
      inspections.total += 1;
      const id = Number(row.id);
      try {
        if (row.original_data == null) throw new Error("pre-migration backup is missing");
        const source = row.original_data;
        const plan = planInspectionAssets(String(row.qc_number), source);
        if (!sameJson(row.data, plan.data)) throw new Error("inspection JSON is not fully migrated");
        for (const asset of plan.assets) {
          await objectStorage.verify(asset.key, {
            bytes: asset.bytes.length,
            sha256: asset.sha256,
          });
        }
        inspections.skipped += 1;
      } catch (error) {
        inspections.mismatches.push(
          `${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
  let mismatchCount = 0;
  for (const value of Object.values(report)) {
    if (typeof value === "object" && "mismatches" in value) mismatchCount += value.mismatches.length;
  }
  report.zeroMismatches = mismatchCount === 0;
  report.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(report, null, 2));
  if (mismatchCount) process.exitCode = 1;
}

main().catch((error) => {
  report.elapsedMs = Date.now() - started;
  console.error(error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});