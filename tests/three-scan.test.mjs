import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/worker.js";

test("3Hentai accepts a CDN media ID different from the gallery ID", async () => {
  const originalFetch = globalThis.fetch;
  const readerPages = btoa(JSON.stringify({
    baseUriImg: "https://s1.3hentai.xyz/d2154904/%s",
    pages: { "1": { f: "1.jpg", w: 1280, h: 1790 }, "2": { f: "2.png", w: 1280, h: 1791 } },
  }));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/d/645588")) {
      return new Response('<title>Galeria - 3Hentai</title><img data-src="https://s1.3hentai.xyz/d2154904/1t.jpg"><img data-src="https://s1.3hentai.xyz/d2154904/2t.jpg">', { headers: { "content-type": "text/html" } });
    }
    if (String(url).endsWith("/d/645588/1")) {
      return new Response(`<script>var readerPages = JSON.parse(atob("${readerPages}"));</script>`, { headers: { "content-type": "text/html" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const request = new Request("https://local.test/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://3hentai.net/d/645588" }),
    });
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.images.map(({ url, previewUrl }) => [url, previewUrl]), [
      ["https://s1.3hentai.xyz/d2154904/1.jpg", "https://s1.3hentai.xyz/d2154904/1t.jpg"],
      ["https://s1.3hentai.xyz/d2154904/2.png", "https://s1.3hentai.xyz/d2154904/2t.jpg"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
