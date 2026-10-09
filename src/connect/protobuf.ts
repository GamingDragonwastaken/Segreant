/**
 * A minimal protobuf wire-format reader: enough to pull known fields out of a
 * message whose schema is published, without a runtime dependency. It reads
 * varints, length-delimited fields and fixed 32/64-bit fields, and stops at the
 * first malformed byte rather than guessing.
 */

export type PbValue = { wire: 0; value: bigint } | { wire: 2; bytes: Uint8Array } | { wire: 1 | 5; bytes: Uint8Array };

/** All fields of one message, by field number, in wire order. Malformed input yields what parsed cleanly. */
export function pbFields(buf: Uint8Array): Map<number, PbValue[]> {
  const out = new Map<number, PbValue[]>();
  let pos = 0;
  const varint = (): bigint | null => {
    let result = 0n;
    let shift = 0n;
    while (pos < buf.length) {
      const b = buf[pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) return null;
    }
    return null;
  };
  while (pos < buf.length) {
    const key = varint();
    if (key === null) break;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0) break;
    let v: PbValue;
    if (wire === 0) {
      const n = varint();
      if (n === null) break;
      v = { wire: 0, value: n };
    } else if (wire === 2) {
      const len = varint();
      if (len === null || pos + Number(len) > buf.length) break;
      v = { wire: 2, bytes: buf.subarray(pos, pos + Number(len)) };
      pos += Number(len);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (pos + size > buf.length) break;
      v = { wire, bytes: buf.subarray(pos, pos + size) };
      pos += size;
    } else {
      break; // groups (3/4) are not used by the schemas read here
    }
    const list = out.get(field) ?? [];
    list.push(v);
    out.set(field, list);
  }
  return out;
}

/** The first varint of a field as a safe number (0 when absent or too large). */
export function pbUint(fields: Map<number, PbValue[]>, field: number): number {
  const v = fields.get(field)?.find((x) => x.wire === 0);
  if (v === undefined || v.wire !== 0) return 0;
  return v.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.value) : 0;
}

/** The first length-delimited field's bytes, or null. */
export function pbBytes(fields: Map<number, PbValue[]>, field: number): Uint8Array | null {
  const v = fields.get(field)?.find((x) => x.wire === 2);
  return v !== undefined && v.wire === 2 ? v.bytes : null;
}

/** The first length-delimited field as UTF-8 text, or null. */
export function pbString(fields: Map<number, PbValue[]>, field: number): string | null {
  const b = pbBytes(fields, field);
  return b === null ? null : Buffer.from(b).toString('utf8');
}

/** A nested message's fields, or null. */
export function pbMessage(fields: Map<number, PbValue[]>, field: number): Map<number, PbValue[]> | null {
  const b = pbBytes(fields, field);
  return b === null ? null : pbFields(b);
}

/** Every varint of a field, including a packed repeated field. */
export function pbUints(fields: Map<number, PbValue[]>, field: number): number[] {
  const out: number[] = [];
  for (const v of fields.get(field) ?? []) {
    if (v.wire === 0) out.push(Number(v.value));
    else if (v.wire === 2) out.push(...packedVarints(v.bytes)); // packed: varints with no keys
  }
  return out;
}

function packedVarints(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    let result = 0n;
    let shift = 0n;
    let done = false;
    while (pos < bytes.length) {
      const b = bytes[pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) { done = true; break; }
      shift += 7n;
    }
    if (!done) break;
    out.push(Number(result));
  }
  return out;
}

/** A google.protobuf.Timestamp message as epoch milliseconds, or null. */
export function pbTimestampMs(ts: Map<number, PbValue[]> | null): number | null {
  if (ts === null) return null;
  const seconds = pbUint(ts, 1);
  if (seconds === 0) return null;
  return seconds * 1000 + Math.floor(pbUint(ts, 2) / 1_000_000);
}
