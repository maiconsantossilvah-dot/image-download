import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/worker.js";

test("Mundo Hentai scanner returns only ordered gallery pages", async () => {
  const originalFetch = globalThis.fetch;
  const article = "https://mundohentaioficial.com/outra-galeria/";
  const html = `
    <title>Outra Galeria - Mundo Hentai</title>
    <img src="https://mundohentaioficial.com/wp-content/uploads/2022/05/logo.png">
    <ul class="post-fotos">
      <li><a href="https://mundohentaioficial.com/galeria?id=123456&img=2"><img src="https://mundohentaioficial.com/wp-content/uploads/2025/01/02.jpg"></a></li>
      <li><a href="https://mundohentaioficial.com/galeria?id=123456&img=1"><img src="https://mundohentaioficial.com/wp-content/uploads/2025/01/01.jpg"></a></li>
      <li><a href="https://mundohentaioficial.com/galeria?id=999999&img=3"><img src="https://mundohentaioficial.com/wp-content/uploads/2025/01/unrelated.jpg"></a></li>
    </ul>
    <img src="https://mundohentaioficial.com/wp-content/uploads/2025/01/recommendation.jpg">`;
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
      ["mundo-hentai-123456-1", "https://mundohentaioficial.com/wp-content/uploads/2025/01/01.jpg"],
      ["mundo-hentai-123456-2", "https://mundohentaioficial.com/wp-content/uploads/2025/01/02.jpg"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
