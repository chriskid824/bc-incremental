/**
 * A content digest (docs/v3 C6 design §2.2, §4.1): 16 hex digits that name a JSON value, the same
 * on every machine and whatever order its objects' keys were written in. The calibration tool
 * records with each fusion the digest of what it was calibrated for (src/data/fusion), so a later
 * edit shows as a stale entry. Pure: no node:crypto (ms25). It tells edits apart; it is no defence
 * against anyone who sets out to collide it.
 */

/** FNV-1a's 32-bit prime. */
const FNV_PRIME = 0x01000193;
/** Lane A starts from FNV-1a's 32-bit offset basis, lane B from its bitwise complement. */
const OFFSET_A = 0x811c9dc5;
const OFFSET_B = 0x7ee3623a;

/**
 * `value` as canonical JSON: JSON.stringify's text with every object's keys in sorted order, so
 * the same entries give the same text whatever order they were built in; arrays keep their order.
 * As in JSON.stringify, a property whose value is undefined, a function or a symbol is left out,
 * such a value in an array or on its own is null, and so are NaN and ±Infinity. For plain data:
 * an object's own enumerable string keys are all it reads.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const entries: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    entries.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${entries.join(',')}}`;
}

const hex = (lane: number): string => (lane >>> 0).toString(16).padStart(8, '0');

/**
 * The digest of `value`: two 32-bit FNV-1a lanes over the UTF-8 bytes of its canonical JSON, each
 * with FNV's prime, lane A from FNV's offset basis (the standard FNV-1a hash of the text) and lane
 * B from its complement; 16 hex digits, lane A first.
 */
export function digest(value: unknown): string {
  let a = OFFSET_A;
  let b = OFFSET_B;
  const add = (byte: number): void => {
    a = Math.imul(a ^ byte, FNV_PRIME);
    b = Math.imul(b ^ byte, FNV_PRIME);
  };
  for (const char of canonicalJson(value)) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      add(code);
    } else if (code < 0x800) {
      add(0xc0 | (code >> 6));
      add(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      add(0xe0 | (code >> 12));
      add(0x80 | ((code >> 6) & 0x3f));
      add(0x80 | (code & 0x3f));
    } else {
      add(0xf0 | (code >> 18));
      add(0x80 | ((code >> 12) & 0x3f));
      add(0x80 | ((code >> 6) & 0x3f));
      add(0x80 | (code & 0x3f));
    }
  }
  return hex(a) + hex(b);
}
