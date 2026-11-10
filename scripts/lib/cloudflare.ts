import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ArtistDatabase, D1Statement } from '../../functions/lib/artistStore.js';

const config = JSON.parse(readFileSync(new URL('../../wrangler.artists.jsonc', import.meta.url), 'utf8'));
export const ACCOUNT_ID: string = config.account_id;
export const ARTIST_DATABASE_ID: string = config.d1_databases[0].database_id;

function credential(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const directories = [process.env.WRANGLER_CONFIG_DIR, join(homedir(), 'Library/Preferences/.wrangler'), join(homedir(), '.config/.wrangler')].filter(Boolean);
  for (const directory of directories) {
    try {
      const text = readFileSync(join(directory!, 'config/default.toml'), 'utf8');
      const token = /^oauth_token\s*=\s*("[^"\n]*")/m.exec(text);
      if (token) return JSON.parse(token[1]);
    } catch { /* try the next Wrangler config location */ }
  }
  throw new Error('Authenticate with Wrangler or set CLOUDFLARE_API_TOKEN outside git.');
}

export function cloudflareClient(): <T>(path: string, method?: string, body?: unknown) => Promise<T> {
  const token = credential();
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT_ID + path, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const data = await response.json() as { success: boolean; result: T; errors?: Array<{ code: number }> };
    if (!response.ok || !data.success) {
      /* Never print the request, environment values, token, or raw API body. */
      throw new Error(`Cloudflare ${method} failed (HTTP ${response.status}; codes ${(data.errors || []).map((error) => error.code).join(',') || 'unknown'}).`);
    }
    return data.result;
  };
}

class RestStatement implements D1Statement {
  values: unknown[] = [];
  constructor(readonly db: RestD1, readonly sql: string) {}
  bind(...values: unknown[]): this {
    if (values.length > 100) throw new Error('D1 parameter limit exceeded.');
    /* D1's REST API accepts numeric arrays as BLOB parameters. The runtime
       binding uses ArrayBuffers; both paths execute identical storage SQL. */
    this.values = values.map((value) => value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value instanceof Uint8Array ? Array.from(value) : value);
    return this;
  }
  async first<T>(): Promise<T | null> { return (await this.all<T>()).results[0] || null; }
  async all<T>(): Promise<{ results: T[] }> { return (await this.db.batch<T>([this]))[0]; }
}

export class RestD1 implements ArtistDatabase {
  constructor(readonly api = cloudflareClient()) {}
  prepare(sql: string): RestStatement { return new RestStatement(this, sql); }
  async batch<T>(statements: RestStatement[]): Promise<Array<{ results: T[] }>> {
    const results = await this.api<Array<{ results: T[]; success: boolean }>>('/d1/database/' + ARTIST_DATABASE_ID + '/query', 'POST', {
      batch: statements.map((statement) => ({ sql: statement.sql, params: statement.values })),
    });
    if (results.length !== statements.length || results.some((result) => !result.success)) throw new Error('D1 batch did not complete successfully.');
    return results.map((result) => ({ results: result.results || [] }));
  }
  withSession(): this { return this; } // The management API reads the primary.
}
