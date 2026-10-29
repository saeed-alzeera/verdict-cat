// Tiny binary writer / reader for the co-op wire format. Little-endian, bounds-checked on read (a malformed packet from
// another machine throws instead of reading garbage), no allocation per field.

export class Writer {
  buf: Uint8Array;
  dv: DataView;
  pos = 0;
  constructor(size = 1200) { this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); }
  reset() { this.pos = 0; return this; }
  get length() { return this.pos; }
  private need(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    nb.set(this.buf);
    this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  u8(v: number) { this.need(1); this.buf[this.pos++] = v & 255; }
  i8(v: number) { this.need(1); this.dv.setInt8(this.pos++, v); }
  u16(v: number) { this.need(2); this.dv.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  i16(v: number) { this.need(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v: number) { this.need(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  f32(v: number) { this.need(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  u24(v: number) { this.need(3); this.buf[this.pos++] = (v >> 16) & 255; this.buf[this.pos++] = (v >> 8) & 255; this.buf[this.pos++] = v & 255; }
  /** Short string (max 255 bytes of UTF-8). */
  str(s: string) {
    const b = new TextEncoder().encode(s);
    const n = Math.min(255, b.length);
    this.u8(n); this.need(n); this.buf.set(b.subarray(0, n), this.pos); this.pos += n;
  }
  /** A copy of what has been written. */
  bytes(): ArrayBuffer { return this.buf.slice(0, this.pos).buffer; }
}

export class Reader {
  dv: DataView;
  pos = 0;
  constructor(public buf: ArrayBuffer) { this.dv = new DataView(buf); }
  get left() { return this.buf.byteLength - this.pos; }
  private chk(n: number) { if (this.pos + n > this.buf.byteLength) throw new RangeError('packet truncated'); }
  u8() { this.chk(1); return this.dv.getUint8(this.pos++); }
  i8() { this.chk(1); return this.dv.getInt8(this.pos++); }
  u16() { this.chk(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.chk(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.chk(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { this.chk(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  u24() { this.chk(3); const v = (this.dv.getUint8(this.pos) << 16) | (this.dv.getUint8(this.pos + 1) << 8) | this.dv.getUint8(this.pos + 2); this.pos += 3; return v; }
  str() { const n = this.u8(); this.chk(n); const s = new TextDecoder().decode(new Uint8Array(this.buf, this.pos, n)); this.pos += n; return s; }
}

/** Quantisers shared by both ends so they always agree. */
export const q8 = (v: number) => Math.round(v * 8);       // position, 1/8 px, +-4096 px
export const q32 = (v: number) => Math.round(v * 32);     // unsigned position, 1/32 px, 0..2047 px
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
