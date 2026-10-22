import { assertPublicUrl, formatFromUrl, normalizePageUrl, safeFetch } from "@/lib/web-security";

export const runtime = "edge";

type Found = { url: string; alt: string; source: string; inline: boolean };

function htmlDecode(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\\\//g, "/").trim();
}

function attributes(raw: string) {
  const output: Record<string, string> = {};
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of raw.matchAll(regex)) output[match[1].toLowerCase()] = htmlDecode(match[2] ?? match[3] ?? match[4] ?? "");
  return output;
}

function bestSrcset(value: string) {
  return value.split(",").map((item) => {
    const match = item.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
    if (!match) return null;
    const score = match[3] === "x" ? Number(match[2] || 1) * 10_000 : Number(match[2] || 0);
    return { value: match[1], score };
  }).filter((item): item is { value: string; score: number } => Boolean(item)).sort((a, b) => b.score - a.score)[0]?.value || "";
}

function resolveImage(value: string, base: URL) {
  const decoded = htmlDecode(value).replace(/^['"]|['"]$/g, "");
  if (!decoded || decoded.startsWith("blob:") || decoded.startsWith("javascript:")) return null;
  if (decoded.startsWith("data:image/")) return decoded.length <= 500_000 ? decoded : null;
  try {
    const resolved = new URL(decoded, base);
    return ["http:", "https:"].includes(resolved.protocol) ? resolved.href : null;
  } catch { return null; }
}

function nhentaiGalleryId(url: URL) {
  if (!/^(?:www\.)?nhentai\.net$/i.test(url.hostname)) return null;
  return url.pathname.match(/^\/g\/(\d+)\/?$/)?.[1] || null;
}

async function scanNhentaiGallery(id: string, pageUrl: URL) {
  const { response } = await safeFetch(new URL(`https://nhentai.net/api/v2/galleries/${id}`), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`A galeria respondeu com o erro ${response.status}.`);
  const gallery = await response.json() as {
    media_id?: unknown;
    pages?: Array<{ number?: number; path?: string; thumbnail?: string; width?: number; height?: number }>;
    title?: { english?: string; japanese?: string };
  };
  const mediaId = String(gallery.media_id || "");
  if (!/^\d+$/.test(mediaId) || !Array.isArray(gallery.pages)) throw new Error("A galeria não retornou uma lista de páginas válida.");
  const fullPath = new RegExp(`^galleries/${mediaId}/[0-9]+\\.(?:jpe?g|png|webp|gif|avif)(?:\\.webp)?$`, "i");
  const thumbnailPath = new RegExp(`^galleries/${mediaId}/[0-9]+t\\.(?:jpe?g|png|webp|gif|avif)(?:\\.webp)?$`, "i");
  const images = gallery.pages.slice(0, 600).map((page, index) => {
    const path = String(page.path || "");
    const thumbnail = String(page.thumbnail || "");
    if (!fullPath.test(path)) return null;
    const number = Number(page.number) || index + 1;
    const url = `https://i.nhentai.net/${path}`;
    return {
      id: `img-${number}-${simpleHash(url)}`,
      url,
      previewUrl: thumbnailPath.test(thumbnail) ? `https://t.nhentai.net/${thumbnail}` : url,
      alt: `Página ${number}`,
      source: "arquivo original da galeria",
      format: formatFromUrl(url),
      width: Number(page.width) || null,
      height: Number(page.height) || null,
      inline: false,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    pageTitle: htmlDecode(String(gallery.title?.english || gallery.title?.japanese || `Galeria ${id}`)).slice(0, 180),
    pageUrl: pageUrl.href,
    images,
    notice: gallery.pages.length > 600 ? "A galeria contém muitas imagens; mostramos as primeiras 600." : undefined,
  };
}

function threeHentaiGalleryId(url: URL) {
  if (!/^(?:www\.)?3hentai\.net$/i.test(url.hostname)) return null;
  return url.pathname.match(/^\/d\/(\d+)(?:\/\d+)?\/?$/)?.[1] || null;
}

async function scan3HentaiGallery(id: string, pageUrl: URL) {
  const { response: galleryResponse } = await safeFetch(new URL(`https://3hentai.net/d/${id}`), { headers: { accept: "text/html" } });
  if (!galleryResponse.ok) throw new Error(`A galeria respondeu com o erro ${galleryResponse.status}.`);
  const galleryHtml = await readHtml(galleryResponse);
  const { response: readerResponse } = await safeFetch(new URL(`https://3hentai.net/d/${id}/1`), { headers: { accept: "text/html" } });
  if (!readerResponse.ok) throw new Error(`O leitor respondeu com o erro ${readerResponse.status}.`);
  const readerHtml = await readHtml(readerResponse);
  const encoded = readerHtml.match(/\breaderPages\s*=\s*JSON\.parse\(atob\(["']([A-Za-z0-9+/=]+)["']\)\)/)?.[1];
  if (!encoded) throw new Error("O leitor não informou os arquivos desta galeria.");
  type ReaderPage = { f?: unknown; w?: unknown; h?: unknown };
  let reader: { baseUriImg?: unknown; pages?: Record<string, ReaderPage> };
  try { reader = JSON.parse(atob(encoded)); }
  catch { throw new Error("A lista de páginas da galeria é inválida."); }
  const template = assertPublicUrl(String(reader.baseUriImg || ""));
  if (!template.hostname.endsWith(".3hentai.xyz") || template.pathname !== `/d${id}/%s` || template.search ||
      !reader.pages || typeof reader.pages !== "object") throw new Error("A lista de páginas da galeria é inválida.");

  const thumbnails = new Map<number, string>();
  for (const match of galleryHtml.matchAll(/(?:data-src|src)\s*=\s*["'](https:\/\/[^"']+)["']/gi)) {
    try {
      const thumbnail = assertPublicUrl(match[1]);
      if (!thumbnail.hostname.endsWith(".3hentai.xyz")) continue;
      const number = thumbnail.pathname.match(new RegExp(`^/d${id}/(\\d+)t\\.(?:jpe?g|png|webp|gif|avif)$`, "i"))?.[1];
      if (number) thumbnails.set(Number(number), thumbnail.href);
    } catch { /* Ignore unrelated images. */ }
  }

  const pages = Object.entries(reader.pages).filter(([number, page]) =>
    /^\d+$/.test(number) && Number(number) > 0 && page && typeof page === "object" &&
    /^\d+\.(?:jpe?g|png|webp|gif|avif)$/i.test(String(page.f || ""))
  ).sort(([a], [b]) => Number(a) - Number(b));
  if (!pages.length) throw new Error("A galeria não retornou páginas de imagem.");
  const images = pages.slice(0, 600).map(([number, page]) => {
    const url = template.href.replace("%s", String(page.f));
    return {
      id: `3hentai-${id}-${number}`,
      url,
      previewUrl: thumbnails.get(Number(number)) || url,
      alt: `Página ${number}`,
      source: "arquivo original da galeria",
      format: formatFromUrl(url),
      width: Number(page.w) || null,
      height: Number(page.h) || null,
      inline: false,
    };
  });
  const title = galleryHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || `Galeria ${id}`;
  return {
    pageTitle: htmlDecode(title).replace(/\s+-\s+3Hentai$/i, "").slice(0, 180),
    pageUrl: pageUrl.href,
    images,
    notice: pages.length > 600 ? "A galeria contém muitas imagens; mostramos as primeiras 600." : undefined,
  };
}

function isRule34Listing(url: URL) {
  return /^(?:www\.)?rule34\.xxx$/i.test(url.hostname) &&
    url.searchParams.get("page") === "post" && url.searchParams.get("s") === "list" &&
    Boolean(url.searchParams.get("tags")?.trim());
}

function publicRule34Image(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = assertPublicUrl(value);
    return /\.(?:jpe?g|png|webp|gif|avif|bmp)$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

async function scanRule34Listing(pageUrl: URL) {
  const userId = String(process.env.RULE34_USER_ID || "").trim();
  const apiKey = String(process.env.RULE34_API_KEY || "").trim();
  if (!userId || !apiKey) throw new Error("O suporte ao Rule34 precisa de user_id e api_key configurados no servidor.");
  const tags = pageUrl.searchParams.get("tags")!.trim();
  if (tags.length > 200) throw new Error("A busca contém tags demais.");
  const rawOffset = pageUrl.searchParams.get("pid") || "0";
  if (!/^\d{1,7}$/.test(rawOffset)) throw new Error("A página da busca é inválida.");
  const offset = Number(rawOffset);
  const pageSize = 600;
  const startPage = Math.floor(offset / pageSize);
  const skip = offset % pageSize;
  type Rule34Post = { id?: unknown; file_url?: unknown; preview_url?: unknown; width?: unknown; height?: unknown };
  const posts: Rule34Post[] = [];
  for (let page = startPage; page <= Math.ceil((offset + pageSize) / pageSize) - 1; page += 1) {
    const endpoint = new URL("https://api.rule34.xxx/index.php");
    for (const [key, value] of Object.entries({ page: "dapi", s: "post", q: "index", json: "1", tags, limit: String(pageSize), pid: String(page), user_id: userId, api_key: apiKey })) endpoint.searchParams.set(key, value);
    const { response } = await safeFetch(endpoint, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`A API do Rule34 respondeu com o erro ${response.status}.`);
    let batch: unknown;
    try { batch = await response.json(); }
    catch { throw new Error("A API do Rule34 não retornou JSON. Verifique as credenciais."); }
    if (!Array.isArray(batch)) throw new Error("A API do Rule34 recusou a busca. Verifique as credenciais.");
    posts.push(...batch as Rule34Post[]);
    if (batch.length < pageSize) break;
  }
  const selected = posts.slice(skip, skip + pageSize);
  const images = selected.map((post) => {
    if (!post || typeof post !== "object" || !/^\d+$/.test(String(post.id || ""))) return null;
    const url = publicRule34Image(post.file_url);
    if (!url) return null;
    return {
      id: `rule34-${post.id}`,
      url,
      previewUrl: publicRule34Image(post.preview_url) || url,
      alt: `Post ${post.id}`,
      source: "arquivo original do Rule34",
      format: formatFromUrl(url),
      width: Number(post.width) || null,
      height: Number(post.height) || null,
      inline: false,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    pageTitle: `Rule34 — ${tags}`.slice(0, 180),
    pageUrl: pageUrl.href,
    images,
    notice: selected.length >= pageSize ? "Mostramos até 600 posts desta busca. Para ver os próximos, use outra página da listagem." : undefined,
  };
}

function extractImages(html: string, base: URL) {
  const found = new Map<string, Found>();
  const add = (raw: string, alt: string, source: string) => {
    const url = resolveImage(raw, base);
    if (!url || found.has(url)) return;
    found.set(url, { url, alt: htmlDecode(alt).slice(0, 220), source, inline: url.startsWith("data:") });
  };

  for (const match of html.matchAll(/<(img|source|meta|link|image)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = attributes(match[2]);
    const alt = attrs.alt || attrs.title || "";
    if (tag === "img") {
      const preferred = attrs["data-original"] || attrs["data-full"] || attrs["data-full-src"] || attrs["data-zoom-image"] || attrs["data-hires"] || bestSrcset(attrs.srcset || attrs["data-srcset"] || "") || attrs["data-lazy-src"] || attrs["data-src"] || attrs.src;
      if (preferred) add(preferred, alt, "elemento img");
    } else if (tag === "source") {
      const preferred = bestSrcset(attrs.srcset || attrs["data-srcset"] || "") || attrs.src;
      if (preferred) add(preferred, alt, "imagem responsiva");
    } else if (tag === "meta") {
      const key = (attrs.property || attrs.name || "").toLowerCase();
      if (["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes(key) && attrs.content) add(attrs.content, attrs["data-alt"] || "Imagem social", "metadado social");
    } else if (tag === "link") {
      const rel = (attrs.rel || "").toLowerCase();
      if ((rel.includes("image_src") || (rel.includes("preload") && attrs.as === "image")) && attrs.href) add(attrs.href, "", "imagem pré-carregada");
      const preferred = bestSrcset(attrs.imagesrcset || "");
      if (preferred) add(preferred, "", "imagem responsiva");
    } else if (tag === "image") {
      const href = attrs.href || attrs["xlink:href"];
      if (href) add(href, alt, "imagem SVG");
    }
    if (attrs.style) for (const urlMatch of attrs.style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) add(urlMatch[2], alt, "imagem de fundo");
  }

  for (const match of html.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) add(match[2], "", "imagem de fundo");
  for (const match of html.matchAll(/(?:^|[\s"'(=])((?:https?:\\?\/\\?\/|(?:\.\.?\/|\/))[^\s"'<>]+?\.(?:avif|webp|png|jpe?g|gif|svg|bmp|tiff?|ico|heic|heif)(?:\?[^\s"'<>]*)?)/gi)) add(match[1], "", "referência no código");

  return Array.from(found.values()).slice(0, 600);
}

async function readHtml(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 5_000_000) throw new Error("Esta página é grande demais para uma varredura segura.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 5_000_000) { await reader.cancel(); throw new Error("Esta página é grande demais para uma varredura segura."); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: unknown };
    if (typeof body.url !== "string") return Response.json({ error: "Informe uma URL válida." }, { status: 400 });
    const initial = normalizePageUrl(body.url);
    const galleryId = nhentaiGalleryId(initial);
    if (galleryId) return Response.json(await scanNhentaiGallery(galleryId, initial), { headers: { "cache-control": "no-store" } });
    const threeHentaiId = threeHentaiGalleryId(initial);
    if (threeHentaiId) return Response.json(await scan3HentaiGallery(threeHentaiId, initial), { headers: { "cache-control": "no-store" } });
    if (isRule34Listing(initial)) return Response.json(await scanRule34Listing(initial), { headers: { "cache-control": "no-store" } });
    const { response, finalUrl } = await safeFetch(initial, { headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.7" } });
    if (!response.ok) throw new Error(`O site respondeu com o erro ${response.status}.`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text")) throw new Error("O endereço não parece ser uma página HTML.");
    const html = await readHtml(response);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || finalUrl.hostname;
    const extracted = extractImages(html, finalUrl);
    const images = extracted.map((image, index) => ({ ...image, id: `img-${index}-${simpleHash(image.url)}`, format: formatFromUrl(image.url) }));
    return Response.json({ pageTitle: htmlDecode(title).slice(0, 180), pageUrl: finalUrl.href, images, notice: extracted.length >= 600 ? "A página contém muitas imagens; mostramos as primeiras 600." : undefined }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível analisar esta página.";
    return Response.json({ error: message }, { status: 400 });
  }
}

function simpleHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
