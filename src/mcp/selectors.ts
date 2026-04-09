export function expandNumericSelector(value: string): number[] | null {
  if (value === "*") {
    return [];
  }

  if (/^\d+$/.test(value)) {
    return [Number(value)];
  }

  const rangeMatch = /^(\d+)\.\.(\d+)$/i.exec(value);
  if (!rangeMatch) {
    return null;
  }

  const start = Number(rangeMatch[1]);
  const end = Number(rangeMatch[2]);
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const values: number[] = [];

  for (let current = lower; current <= upper; current += 1) {
    values.push(current);
  }

  return values;
}
