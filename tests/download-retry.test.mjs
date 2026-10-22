import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchImageWithRetry } from "../lib/zip-batches.js";

const item = { name: "foto.jpg", url: "https://example.com/foto.jpg" };

function imageResponse(content = "data", expectedLength = content.length) {
  return new Response(new Blob([content], { type: "image/jpeg" }), {
    headers: { "content-type": "image/jpeg", "content-length": String(expectedLength) },
  });
}

function setup(responses) {
  const delays = [];
  const retries = [];
  let calls = 0;
  const fetcher = async () => {
    const result = responses[calls++];
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    run: () => fetchImageWithRetry(item, (url) => `/api/image?url=${encodeURIComponent(url)}`, (...values) => retries.push(values), fetcher, async (ms) => { delays.push(ms); }),
    delays,
    retries,
    calls: () => calls,
  };
}

test("retries an incomplete image before adding it to the ZIP", async () => {
  const task = setup([imageResponse("bad", 4), imageResponse("good")]);
  const image = await task.run();
  assert.equal(await image.text(), "good");
  assert.equal(task.calls(), 2);
  assert.deepEqual(task.retries, [[2, 3]]);
  assert.deepEqual(task.delays, [750]);
});

test("stops after three interrupted image requests", async () => {
  const task = setup([new Error("network"), new Error("network"), new Error("network")]);
  await assert.rejects(task.run(), /Falha em foto.jpg/);
  assert.equal(task.calls(), 3);
  assert.deepEqual(task.delays, [750, 1500]);
});

test("does not retry invalid image requests", async () => {
  const task = setup([Response.json({ error: "Imagem indisponível." }, { status: 400 })]);
  await assert.rejects(task.run(), /Imagem indisponível/);
  assert.equal(task.calls(), 1);
});

test("retries a temporary server error", async () => {
  const task = setup([Response.json({ error: "temporário" }, { status: 503 }), imageResponse()]);
  assert.equal((await task.run()).size, 4);
  assert.equal(task.calls(), 2);
});
