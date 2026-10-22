import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeZipParts, splitZipBatches, uniqueZipItemNames, ZIP_BATCH_SIZE } from "../lib/zip-batches.js";

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function oneFileZip(name, content) {
  const nameBytes = Buffer.from(name);
  const data = Buffer.from(content);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0808, 6);
  local.writeUInt16LE(nameBytes.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(checksum, 4);
  descriptor.writeUInt32LE(data.length, 8);
  descriptor.writeUInt32LE(data.length, 12);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x0808, 8);
  directory.writeUInt32LE(checksum, 16);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(nameBytes.length, 28);
  const offset = local.length + nameBytes.length + data.length + descriptor.length;
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(1, 8);
  footer.writeUInt16LE(1, 10);
  footer.writeUInt32LE(directory.length + nameBytes.length, 12);
  footer.writeUInt32LE(offset, 16);
  return new Blob([local, nameBytes, data, descriptor, directory, nameBytes, footer]);
}

test("splits large selections below the Worker subrequest limit", () => {
  const batches = splitZipBatches(Array.from({ length: 41 }, (_, index) => index));
  assert.equal(ZIP_BATCH_SIZE, 8);
  assert.deepEqual(batches.map((batch) => batch.length), [8, 8, 8, 8, 8, 1]);
  assert.deepEqual(batches.flat(), Array.from({ length: 41 }, (_, index) => index));
});

test("keeps original filenames across batches and renames only duplicates", () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ url: `https://example.com/${index}`, name: index === 8 ? "Foto.JPG" : index === 0 ? "foto.jpg" : `imagem-${index}.jpg` }));
  const batches = splitZipBatches(uniqueZipItemNames(items));
  assert.equal(batches[0][0].name, "foto.jpg");
  assert.equal(batches[1][0].name, "Foto (2).JPG");
  assert.equal(batches[0][1].name, "imagem-1.jpg");
});

test("combines separate ZIP responses into one readable ZIP", async () => {
  const merged = await mergeZipParts([oneFileZip("one.jpg", "first"), oneFileZip("two.jpg", "second")]);
  const bytes = Buffer.from(await merged.arrayBuffer());
  const footerOffset = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(footerOffset), 0x06054b50);
  assert.equal(bytes.readUInt16LE(footerOffset + 10), 2);
  let cursor = bytes.readUInt32LE(footerOffset + 16);
  const entries = [];
  for (let index = 0; index < 2; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26);
    const data = bytes.toString("utf8", dataOffset, dataOffset + bytes.readUInt32LE(cursor + 24));
    entries.push([name, data]);
    cursor += 46 + nameLength;
  }
  assert.equal(cursor, footerOffset);
  assert.deepEqual(entries, [["one.jpg", "first"], ["two.jpg", "second"]]);
});
