/** Plain timestamped log lines (stdout). Never pass credentials or message keys here. */
export function log(...parts: unknown[]): void {
  const line = parts.map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}
