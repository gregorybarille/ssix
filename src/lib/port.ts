/**
 * Strictly parse a TCP/IP port number from user input.
 *
 * Returns `value` as the parsed integer when the input is valid (an
 * integer in the 1..65535 range), and `error` describing the problem
 * otherwise. Empty input is treated as "missing" and returns
 * `{ value: null, error: null }` so callers can decide whether the
 * field is required.
 *
 * The previous code path silently coerced any invalid input to `22`,
 * which corrupted typed-but-not-yet-finished input (e.g. "2200" while
 * the user is mid-typing) and hid out-of-range values. This helper
 * lets callers surface the problem to the user instead.
 */
export interface ParsedPort {
  value: number | null;
  error: string | null;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

export function parsePort(input: string | number | undefined | null): ParsedPort {
  if (input === undefined || input === null) {
    return { value: null, error: null };
  }
  const raw = typeof input === "number" ? String(input) : input.trim();
  if (raw === "") {
    return { value: null, error: null };
  }
  // Reject anything that's not a sequence of digits — no signs, no
  // decimals, no whitespace, no thousands separators.
  if (!/^\d+$/.test(raw)) {
    return { value: null, error: "Port must be a whole number" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { value: null, error: "Port must be a whole number" };
  }
  if (n < MIN_PORT || n > MAX_PORT) {
    return {
      value: null,
      error: `Port must be between ${MIN_PORT} and ${MAX_PORT}`,
    };
  }
  return { value: n, error: null };
}

/** True if the parsed value is an in-range integer port. */
export function isValidPort(input: string | number | undefined | null): boolean {
  return parsePort(input).value !== null;
}
