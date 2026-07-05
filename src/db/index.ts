import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "../lib/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | null = null;
let db: Database | null = null;

/**
 * Lazily create (and memoize) the Drizzle client. Lazy so that importing the db
 * module doesn't require DATABASE_URL at build time.
 */
export function getDb(): Database {
  if (db) return db;
  const { DATABASE_URL } = getEnv();
  client = postgres(DATABASE_URL, { max: 10 });
  db = drizzle(client, { schema });
  return db;
}

export { schema };
