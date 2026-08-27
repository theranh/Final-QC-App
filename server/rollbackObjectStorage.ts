import pg from "pg";

type Counts = { total: number; migrated: number; skipped: number; mismatches: string[] };

const started = Date.now();
const report: Record<string, Counts | number> = {
  inspections: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  photos: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
  orientationBackups: { total: 0, migrated: 0, skipped: 0, mismatches: [] },
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const inspections = report.inspections as Counts;
      const inspectionTotal = await client.query(
        "SELECT count(*)::int AS count FROM inspections_data_premigration",
      );
      inspections.total = inspectionTotal.rows[0].count;
      const restored = await client.query(
        `UPDATE inspections i SET data = b.original_data
           FROM inspections_data_premigration b
          WHERE i.id = b.inspection_id AND i.data IS DISTINCT FROM b.original_data`,
      );
      inspections.migrated = restored.rowCount ?? 0;
      inspections.skipped = inspections.total - inspections.migrated;

      const photos = report.photos as Counts;
      const photoTotal = await client.query(
        "SELECT count(*)::int AS count, count(*) FILTER (WHERE object_key IS NULL AND sha256 IS NULL)::int AS clear FROM photos",
      );
      photos.total = photoTotal.rows[0].count;
      photos.skipped = photoTotal.rows[0].clear;
      const clearedPhotos = await client.query(
        "UPDATE photos SET object_key = NULL, sha256 = NULL WHERE object_key IS NOT NULL OR sha256 IS NOT NULL",
      );
      photos.migrated = clearedPhotos.rowCount ?? 0;

      const orientation = report.orientationBackups as Counts;
      const orientationTotal = await client.query(
        "SELECT count(*)::int AS count, count(*) FILTER (WHERE object_key IS NULL AND storage_sha256 IS NULL)::int AS clear FROM photo_orientation_backups",
      );
      orientation.total = orientationTotal.rows[0].count;
      orientation.skipped = orientationTotal.rows[0].clear;
      const clearedOrientation = await client.query(
        `UPDATE photo_orientation_backups
            SET object_key = NULL, storage_sha256 = NULL
          WHERE object_key IS NOT NULL OR storage_sha256 IS NOT NULL`,
      );
      orientation.migrated = clearedOrientation.rowCount ?? 0;

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  report.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  report.elapsedMs = Date.now() - started;
  console.error(error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});