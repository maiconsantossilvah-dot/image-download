import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("  async function verifyZip(blob)");
const end = source.indexOf("  async function scan(", start);
assert.ok(start >= 0 && end > start);
const downloadFunctions = source.slice(start, end);

function validZip() {
  const bytes = new Uint8Array(68);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint32(46, 0x06054b50, true);
  view.setUint16(54, 1, true);
  view.setUint32(58, 46, true);
  return new Blob([bytes]);
}

function setup(responses) {
  const delays = [];
  const retries = [];
  let calls = 0;
  const context = {
    Blob,
    DataView,
    URL,
    apiUrl: (path) => path,
    fetch: async () => responses[calls++],
    readJson: async (response) => { throw new Error(`HTTP ${response.status}`); },
    window: { setTimeout: (resolve, delay) => { delays.push(delay); resolve(); } },
  };
  const { fetchZipWithRetry } = vm.runInNewContext(`(() => { ${downloadFunctions}; return { fetchZipWithRetry }; })()`, context);
  return { run: () => fetchZipWithRetry([{ url: "https://example.com/image.jpg" }], (...values) => retries.push(values)), delays, retries, calls: () => calls };
}

test("retries an interrupted ZIP and downloads only the verified result", async () => {
  const valid = validZip();
  const task = setup([
    { ok: true, blob: async () => new Blob(["incomplete"]) },
    { ok: true, blob: async () => valid },
  ]);
  assert.equal(await task.run(), valid);
  assert.equal(task.calls(), 2);
  assert.deepEqual(task.retries, [[2, 3]]);
  assert.deepEqual(task.delays, [750]);
});

test("stops after three interrupted ZIP responses", async () => {
  const task = setup(Array.from({ length: 3 }, () => ({ ok: true, blob: async () => new Blob(["incomplete"]) })));
  await assert.rejects(task.run(), /após 3 tentativas/);
  assert.equal(task.calls(), 3);
  assert.deepEqual(task.delays, [750, 1500]);
});

test("does not retry invalid requests", async () => {
  const task = setup([{ ok: false, status: 400 }]);
  await assert.rejects(task.run(), /HTTP 400/);
  assert.equal(task.calls(), 1);
  assert.deepEqual(task.delays, []);
});

test("retries a temporary server error", async () => {
  const valid = validZip();
  const task = setup([{ ok: false, status: 503 }, { ok: true, blob: async () => valid }]);
  assert.equal(await task.run(), valid);
  assert.equal(task.calls(), 2);
});
