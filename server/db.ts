import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  // Recycle idle clients well before the server side drops them, so requests
  // never land on a dead connection.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// A dropped idle connection emits 'error' on the pool; without a handler this
// crashes the whole process (and takes the deployment down with it).
pool.on("error", (err) => {
  console.error("Postgres pool error (idle client):", err.message);
});
export const db = drizzle(pool, { schema });
