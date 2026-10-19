/** Formats seconds as `h:mm:ss.mmm` (hours omitted when zero). */
export function formatTime(seconds: number, decimals = 3): string {
  const sign = seconds < 0 ? '-' : '';
  const scale = 10 ** decimals;
  let total = Math.round(Math.abs(seconds) * scale);
  const frac = total % scale;
  total = (total - frac) / scale;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const fracStr = decimals > 0 ? '.' + String(frac).padStart(decimals, '0') : '';
  const ss = String(s).padStart(2, '0');
  return h > 0
    ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}${fracStr}`
    : `${sign}${m}:${ss}${fracStr}`;
}

/** Parses `ss`, `m:ss`, `h:mm:ss`, each with optional decimals (`.` or `,`). Returns null if invalid. */
export function parseTime(text: string): number | null {
  const parts = text.trim().replace(',', '.').split(':');
  if (parts.length === 0 || parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (!(isLast ? /^\d+(\.\d+)?$/ : /^\d+$/).test(part)) return null;
    total = total * 60 + Number(part);
  }
  return total;
}
