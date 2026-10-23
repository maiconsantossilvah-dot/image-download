import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/worker.js";

test("Hentai da Tia returns ordered full resolution gallery pages only", async () => {
  const originalFetch = globalThis.fetch;
  const article = "https://hentaidatia.com/uma-outra-obra/";
  const prefix = "https://hentaidatia.com/wp-content/uploads/2026/09/uma-outra-obra";
  const html = `
    <title>Uma outra obra - Hentai da Tia</title>
    <img data-src="https://hentaidatia.com/wp-content/uploads/2026/09/logo.webp">
    <ul class="post-fotos">
      <li><a href="/galeria?id=987654&#038;img=2#galeria"><img src="data:image/svg+xml;base64,AA==" data-src="${prefix}-002-215x300.webp" data-srcset="${prefix}-002-215x300.webp 215w, ${prefix}-002.webp 1014w"></a></li>
      <li><a href="/galeria?id=987654&#038;img=1#galeria"><img data-src="${prefix}-001-215x300.webp" data-srcset="${prefix}-001-215x300.webp 215w, ${prefix}-001.webp 1014w"></a></li>
      <li><a href="/galeria?id=111111&#038;img=3#galeria"><img data-srcset="${prefix}-003.webp 1014w"></a></li>
    </ul>
    <img data-src="https://hentaidatia.com/wp-content/uploads/2026/09/recommendation.webp">`;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), article);
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  try {
    const response = await worker.fetch(new Request("https://local.test/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: article }),
    }), {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.images.map(({ id, url }) => [id, url]), [
      ["hentai-da-tia-987654-1", `${prefix}-001.webp`],
      ["hentai-da-tia-987654-2", `${prefix}-002.webp`],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
