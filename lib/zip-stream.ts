type ZipEntry = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number };

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function u16(value: number) { return [value & 255, (value >>> 8) & 255]; }
function u32(value: number) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }
function bytes(values: number[]) { return new Uint8Array(values); }

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

function updateCrc(current: number, chunk: Uint8Array) {
  let crc = current;
  for (const value of chunk) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

export function safeFileName(value: string, index: number) {
  const fallback = `imagem-${String(index + 1).padStart(3, "0")}`;
  const clean = value.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").trim();
  return (clean || fallback).slice(-150);
}

export function uniqueFileName(name: string, usedNames: Set<string>) {
  const match = name.match(/^(.*?)(\.[^.]+)?$/)!;
  const base = match[1];
  const extension = match[2] || "";
  let unique = name;
  for (let suffix = 2; usedNames.has(unique.toLowerCase()); suffix += 1) unique = `${base} (${suffix})${extension}`;
  usedNames.add(unique.toLowerCase());
  return unique;
}

export function createZipStream(produce: (writer: ZipWriter) => Promise<void>) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const output = stream.writable.getWriter();
  const writer = new ZipWriter(output);
  void (async () => {
    try { await produce(writer); await writer.close(); }
    catch (error) { await output.abort(error).catch(() => {}); }
  })();
  return stream.readable;
}

export class ZipWriter {
  private offset = 0;
  private entries: ZipEntry[] = [];
  private failed = false;
  constructor(private output: WritableStreamDefaultWriter<Uint8Array>) {}

  private async push(chunk: Uint8Array) { await this.output.write(chunk); this.offset += chunk.byteLength; }

  async add(nameValue: string, stream: ReadableStream<Uint8Array> | Uint8Array) {
    if (this.failed) throw new Error("O fluxo do ZIP foi interrompido.");
    const name = encoder.encode(nameValue);
    const { time, date } = dosDateTime();
    const entryOffset = this.offset;
    await this.push(bytes([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0808), ...u16(0), ...u16(time), ...u16(date),
      ...u32(0), ...u32(0), ...u32(0), ...u16(name.length), ...u16(0),
    ]));
    await this.push(name);
    let crc = 0xffffffff;
    let size = 0;
    try {
      if (stream instanceof Uint8Array) {
        crc = updateCrc(crc, stream); size = stream.byteLength; await this.push(stream);
      } else {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 100_000_000) { await reader.cancel(); throw new Error("arquivo maior que 100 MB"); }
            crc = updateCrc(crc, value); await this.push(value);
          }
        } finally { reader.releaseLock(); }
      }
    } catch (error) {
      this.failed = true;
      throw error;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    await this.push(bytes([...u32(0x08074b50), ...u32(crc), ...u32(size), ...u32(size)]));
    this.entries.push({ name, crc, size, offset: entryOffset, time, date });
  }

  async close() {
    if (this.failed) throw new Error("O fluxo do ZIP foi interrompido.");
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      await this.push(bytes([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0808), ...u16(0), ...u16(entry.time), ...u16(entry.date),
        ...u32(entry.crc), ...u32(entry.size), ...u32(entry.size), ...u16(entry.name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(entry.offset),
      ]));
      await this.push(entry.name);
    }
    const directorySize = this.offset - directoryOffset;
    await this.push(bytes([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(this.entries.length), ...u16(this.entries.length), ...u32(directorySize), ...u32(directoryOffset), ...u16(0)]));
    await this.output.close();
  }
}
