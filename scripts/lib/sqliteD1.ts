import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ArtistDatabase, D1Statement } from '../../functions/lib/artistStore.js';

class Statement implements D1Statement {
  values: unknown[] = [];
  constructor(readonly db: SqliteD1, readonly sql: string) {}
  bind(...values: unknown[]): this {
    if (values.length > 100) throw new Error('D1 parameter limit exceeded');
    this.db.maxParameters = Math.max(this.db.maxParameters, values.length);
    this.values = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    return this;
  }
  execute(): Record<string, unknown>[] {
    return this.db.sqlite.prepare(this.sql).all(...this.values as any[]) as Record<string, unknown>[];
  }
  async first<T>(): Promise<T | null> { return (this.execute()[0] as T) || null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.execute() as T[] }; }
}

/* Executes the real production SQL, including transaction rollback and BLOBs.
   Also enforces D1's limits so a SQLite-only batching regression cannot pass. */
export class SqliteD1 implements ArtistDatabase {
  sqlite = new DatabaseSync(':memory:');
  maxParameters = 0;
  maxBatch = 0;
  beforeBatch?: (statements: Statement[]) => Promise<void>;
  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of ['0001_artist_storage.sql', '0002_track_artist_edits.sql']) {
      this.sqlite.exec(readFileSync(new URL('../../migrations/artists/' + file, import.meta.url), 'utf8'));
    }
  }
  prepare(sql: string): Statement { return new Statement(this, sql); }
  async batch<T>(statements: Statement[]): Promise<Array<{ results: T[] }>> {
    if (statements.length > 50) throw new Error('D1 free-tier query limit exceeded');
    this.maxBatch = Math.max(this.maxBatch, statements.length);
    await this.beforeBatch?.(statements);
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => ({ results: statement.execute() as T[] }));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  withSession(constraint: string): this {
    if (constraint !== 'first-primary') throw new Error('Expected primary reads');
    return this;
  }
  count(table: string): number {
    return Number((this.sqlite.prepare('SELECT count(*) AS n FROM ' + table).get() as any).n);
  }
  close(): void { this.sqlite.close(); }
}
