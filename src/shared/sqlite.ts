import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT, StatementSync } from 'node:sqlite';

/**
 * Thin wrapper over Node's built-in SQLite (node:sqlite) with the small part of
 * the better-sqlite3 API this project uses. Using the built-in module means
 * there is no native add-on to compile or download during "npm install",
 * which was the most common install failure on Windows.
 */

// Hide only Node's "SQLite is an experimental feature" warning (it would confuse users).
const origEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (origEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncT };

type Param = string | number | bigint | null | Uint8Array;
type Bindable = Param | boolean | undefined;

function clean(v: Bindable): Param {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function bind(args: unknown[]): unknown[] {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array)) {
    const out: Record<string, Param> = {};
    for (const [k, v] of Object.entries(args[0] as Record<string, Bindable>)) out[k] = clean(v);
    return [out];
  }
  return args.map((a) => clean(a as Bindable));
}

const plain = <T>(row: unknown): T => (row && typeof row === 'object' ? { ...(row as object) } : row) as T;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Statement {
  constructor(private readonly stmt: StatementSync) {}
  run(...args: unknown[]): RunResult {
    const r = (this.stmt.run as (...a: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(...bind(args));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...args: unknown[]): unknown {
    return plain((this.stmt.get as (...a: unknown[]) => unknown)(...bind(args)));
  }
  all(...args: unknown[]): unknown[] {
    return ((this.stmt.all as (...a: unknown[]) => unknown[])(...bind(args))).map((r) => plain(r));
  }
}

export class Database {
  private readonly db: DatabaseSyncT;
  private depth = 0;

  constructor(file: string, opts: { readonly?: boolean } = {}) {
    this.db = new DatabaseSync(file, { readOnly: !!opts.readonly });
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(p: string): void {
    this.db.exec(`PRAGMA ${p}`);
  }

  /** Same shape as better-sqlite3: returns a function that runs `fn` inside a transaction. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      const sp = `sp_${this.depth}`;
      this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.depth--;
        this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
