/** Unix seconds -> local ISO string with offset, e.g. 2026-11-15T21:04:05+05:00 */
export function toLocalIso(sec: number): string {
  const d = new Date(sec * 1000);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/** Parse a user/Claude supplied date ("2026-11-15", "2026-11-15T10:00", ISO) into unix seconds. */
export function parseDate(input: string, field: string): number {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`"${field}" is not a valid date: ${input}. Use e.g. 2026-11-15 or 2026-11-15T14:30.`);
  return Math.floor(ms / 1000);
}
