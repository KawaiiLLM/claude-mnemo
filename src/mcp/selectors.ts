/**
 * Expand `*`, a single number, or a closed range into concrete values.
 *
 * A range's second endpoint may repeat the selector's own kind letter —
 * `T3..T7` reads as naturally as `T3..7`, and the `remember` tool's interval
 * grammar historically REQUIRED the repeated letter, so one session working
 * both surfaces inevitably writes both shapes ([S15069/T1021]). A repeated
 * letter must match `endpointPrefix` (the kind the caller already stripped
 * from the front), so a cross-kind range like `S12/T3..O7` stays illegal.
 */
export function expandNumericSelector(
  value: string,
  endpointPrefix?: string,
): number[] | null {
  if (value === "*") {
    return [];
  }

  if (/^\d+$/.test(value)) {
    return [Number(value)];
  }

  const rangeMatch = /^(\d+)\.\.([A-Za-z]?)(\d+)$/.exec(value);
  if (!rangeMatch) {
    return null;
  }

  const repeatedLetter = rangeMatch[2] ?? "";
  if (
    repeatedLetter !== "" &&
    repeatedLetter.toUpperCase() !== (endpointPrefix ?? "").toUpperCase()
  ) {
    return null;
  }

  const start = Number(rangeMatch[1]);
  const end = Number(rangeMatch[3]);
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const values: number[] = [];

  for (let current = lower; current <= upper; current += 1) {
    values.push(current);
  }

  return values;
}
