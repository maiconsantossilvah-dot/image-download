export const ZIP_BATCH_SIZE = 50;

/** @typedef {{ parts: Blob[] }} ZipRecovery */

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

/** @template T @param {T[]} items @returns {T[][]} */
export function splitZipBatches(items) {
  const batches = [];
  for (let index = 0; index < items.length; index += ZIP_BATCH_SIZE) {
    batches.push(items.slice(index, index + ZIP_BATCH_SIZE));
  }
  return batches;
}

export function createZipDownloadSession() {
  let key = "";
  let parts = [];
  /** @type {ZipRecovery[]} */
  let recovery = [];
  return {
    /** @template T @param {T[]} items @param {(batch: T[], index: number, total: number, recovery: ZipRecovery) => Promise<Blob>} fetchPart @param {(index: number, total: number) => void} onPart */
    async run(items, fetchPart, onPart) {
      const nextKey = JSON.stringify(items);
      if (key !== nextKey) {
        key = nextKey;
        parts = [];
        recovery = [];
      }
      const batches = splitZipBatches(items);
      for (let index = 0; index < batches.length; index++) {
        if (parts[index]) continue;
        onPart(index + 1, batches.length);
        recovery[index] ||= { parts: [] };
        parts[index] = await fetchPart(batches[index], index, batches.length, recovery[index]);
        recovery[index] = { parts: [] };
      }
      return mergeZipParts(parts);
    },
    reset() {
      key = "";
      parts = [];
      recovery = [];
    },
    completedCount() {
      return parts.filter(Boolean).length + recovery.reduce((count, item) => count + (item?.parts.filter(Boolean).length || 0), 0);
    },
  };
}

/** @param {Blob} blob @param {number} expectedCount */
export async function zipHasAllImages(blob, expectedCount) {
  if (blob.size < 22) return false;
  const footer = new DataView(await blob.slice(-22).arrayBuffer());
  if (footer.getUint32(0, true) !== 0x06054b50) return false;
  const count = footer.getUint16(10, true);
  const directorySize = footer.getUint32(12, true);
  const directoryOffset = footer.getUint32(16, true);
  if (count !== expectedCount || directoryOffset + directorySize + 22 !== blob.size) return false;
  const bytes = new Uint8Array(await blob.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const decoder = new TextDecoder();
  let cursor = 0;
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > bytes.length) return false;
    const view = new DataView(bytes.buffer, cursor);
    if (view.getUint32(0, true) !== 0x02014b50) return false;
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    if (cursor + 46 + nameLength + extraLength + commentLength > bytes.length) return false;
    if (decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)) === "falhas.txt") return false;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return cursor === bytes.length;
}

/** @param {{url: string, name: string}} item @param {(url: string) => string} proxyUrl @param {(attempt: number, total: number) => void} onRetry @param {typeof fetch} [fetcher] @param {(ms: number) => Promise<void>} [wait] */
export async function fetchImageWithRetry(item, proxyUrl, onRetry, fetcher = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const url = item.url.startsWith("data:image/") ? item.url : proxyUrl(item.url);
      const response = await fetcher(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `A imagem não pôde ser baixada (${response.status}).`);
      }
      const type = response.headers.get("content-type") || "";
      if (!type.toLowerCase().startsWith("image/")) {
        retryable = false;
        throw new Error("O endereço não retornou uma imagem.");
      }
      const blob = await response.blob();
      const length = Number(response.headers.get("content-length") || 0);
      if (!blob.size || (length > 0 && blob.size !== length && type.toLowerCase() !== "image/svg+xml")) throw new Error("A imagem chegou incompleta.");
      if (blob.size > 100_000_000) {
        retryable = false;
        throw new Error("A imagem é maior que 100 MB.");
      }
      return blob;
    } catch (error) {
      clearTimeout(timer);
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Falha em ${item.name}: ${error instanceof Error ? error.message : "imagem indisponível"}`);
      }
      onRetry(attempt + 1, maxAttempts);
      await wait(750 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Falha em ${item.name}.`);
}

/** @param {string} name @param {Blob} image */
export async function imageToZip(name, image) {
  const nameBytes = new TextEncoder().encode(name);
  if (!nameBytes.length || nameBytes.length > 0xffff || image.size + nameBytes.length * 2 + 98 > 0xffffffff) {
    throw new Error("A imagem é grande demais para o ZIP.");
  }
  let crc = 0xffffffff;
  let processed = 0;
  const reader = image.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      processed += value.byteLength;
      if (processed >= 1_000_000) {
        processed = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const now = new Date();
  const time = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
  const date = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  const local = new Uint8Array(30);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, 0x0800, true);
  localView.setUint16(10, time, true);
  localView.setUint16(12, date, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, image.size, true);
  localView.setUint32(22, image.size, true);
  localView.setUint16(26, nameBytes.length, true);
  const central = new Uint8Array(46);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, 0x0800, true);
  centralView.setUint16(12, time, true);
  centralView.setUint16(14, date, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, image.size, true);
  centralView.setUint32(24, image.size, true);
  centralView.setUint16(28, nameBytes.length, true);
  const footer = new Uint8Array(22);
  const footerView = new DataView(footer.buffer);
  footerView.setUint32(0, 0x06054b50, true);
  footerView.setUint16(8, 1, true);
  footerView.setUint16(10, 1, true);
  footerView.setUint32(12, central.length + nameBytes.length, true);
  footerView.setUint32(16, local.length + nameBytes.length + image.size, true);
  return new Blob([local, nameBytes, image, central, nameBytes, footer], { type: "application/zip" });
}

/** @template {{url: string, name: string}} T @param {T[]} items @param {(item: T, index: number) => Promise<Blob>} fetchImage @param {ZipRecovery} recovery @param {(done: number, total: number) => void} onProgress */
export async function fetchImagesZipPart(items, fetchImage, recovery, onProgress) {
  for (let index = 0; index < items.length; index++) {
    if (recovery.parts[index]) continue;
    const image = await fetchImage(items[index], index);
    recovery.parts[index] = await imageToZip(items[index].name, image);
    onProgress(index + 1, items.length);
  }
  return mergeZipParts(recovery.parts);
}

/** @template {{name: string, url: string, format?: string}} T @param {T[]} items @returns {T[]} */
export function uniqueZipItemNames(items) {
  const usedNames = new Set();
  return items.map((item, index) => {
    const fallback = `imagem-${String(index + 1).padStart(3, "0")}`;
    const clean = item.name.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").trim();
    let name = (clean || fallback).slice(-150);
    if (!/\.[a-z0-9]{2,6}$/i.test(name) && item.format && item.format !== "IMG") name += `.${item.format.toLowerCase()}`;
    const match = name.match(/^(.*?)(\.[^.]+)?$/);
    const base = match[1];
    const extension = match[2] || "";
    let unique = name;
    for (let suffix = 2; usedNames.has(unique.toLowerCase()); suffix++) unique = `${base} (${suffix})${extension}`;
    usedNames.add(unique.toLowerCase());
    return { ...item, name: unique };
  });
}

/** Combine ZIPs generated by our uncompressed ZIP writer without changing the image data. @param {Blob[]} parts @returns {Promise<Blob>} */
export async function mergeZipParts(parts) {
  if (!parts.length) throw new Error("Nenhuma imagem foi baixada.");
  if (parts.length === 1) return parts[0];

  const localSections = [];
  const directories = [];
  let localSize = 0;
  let directorySize = 0;
  let entryCount = 0;

  for (const part of parts) {
    if (part.size < 22) throw new Error("Uma parte do ZIP está incompleta.");
    const footerOffset = part.size - 22;
    const footer = new DataView(await part.slice(-22).arrayBuffer());
    if (footer.getUint32(0, true) !== 0x06054b50 || footer.getUint16(20, true) !== 0) {
      throw new Error("Uma parte do ZIP está incompleta.");
    }
    const count = footer.getUint16(10, true);
    const size = footer.getUint32(12, true);
    const offset = footer.getUint32(16, true);
    if (!count || offset + size !== footerOffset || localSize + offset > 0xffffffff) {
      throw new Error("Uma parte do ZIP está incompleta ou é grande demais.");
    }

    const directory = new Uint8Array(await part.slice(offset, footerOffset).arrayBuffer());
    const view = new DataView(directory.buffer);
    let cursor = 0;
    for (let entry = 0; entry < count; entry++) {
      if (cursor + 46 > directory.length || view.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error("O índice de uma parte do ZIP está inválido.");
      }
      const oldOffset = view.getUint32(cursor + 42, true);
      if (oldOffset >= offset) throw new Error("O índice de uma parte do ZIP está inválido.");
      view.setUint32(cursor + 42, oldOffset + localSize, true);
      cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    }
    if (cursor !== directory.length) throw new Error("O índice de uma parte do ZIP está inválido.");

    localSections.push(part.slice(0, offset));
    directories.push(directory);
    localSize += offset;
    directorySize += size;
    entryCount += count;
  }

  if (entryCount > 0xffff || localSize + directorySize > 0xffffffff) {
    throw new Error("O ZIP completo é grande demais para ser criado no navegador.");
  }
  const footer = new Uint8Array(22);
  const view = new DataView(footer.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, localSize, true);
  return new Blob([...localSections, ...directories, footer], { type: "application/zip" });
}
