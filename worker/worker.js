const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const IMAGE_TYPES = {
  "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WEBP", "image/gif": "GIF",
  "image/svg+xml": "SVG", "image/avif": "AVIF", "image/bmp": "BMP", "image/tiff": "TIFF",
  "image/x-icon": "ICO", "image/vnd.microsoft.icon": "ICO", "image/heic": "HEIC", "image/heif": "HEIF",
};
const EXTENSION_BY_TYPE = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/heic": "heic", "image/heif": "heif",
};

export default {
  async fetch(request, env) {
    const originHeaders = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      if (!originHeaders.has("access-control-allow-origin")) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: originHeaders });
    }

    try {
      const { pathname } = new URL(request.url);
      let response;
      if (pathname === "/health" && request.method === "GET") {
        response = json({ ok: true, service: "captura-imagens-api" });
      } else if (pathname === "/api/scan" && request.method === "POST") {
        response = await scan(request);
      } else if (pathname === "/api/image" && request.method === "GET") {
        response = await proxyImage(request);
      } else if (pathname === "/api/bundle" && request.method === "POST") {
        response = await bundle(request);
      } else {
        response = json({ error: "Rota não encontrada." }, 404);
      }
      return withHeaders(response, originHeaders);
    } catch (error) {
      return withHeaders(json({ error: messageOf(error, "A solicitação não pôde ser concluída.") }, 400), originHeaders);
    }
  },
};

function corsHeaders(request, env) {
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "content-disposition,content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });
  const origin = request.headers.get("origin");
  if (!origin) headers.set("access-control-allow-origin", "*");
  else if (allowedOrigin(origin, env)) headers.set("access-control-allow-origin", origin);
  return headers;
}

function allowedOrigin(origin, env) {
  const configured = String(env.ALLOWED_ORIGIN || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (configured.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function withHeaders(response, additional) {
  const headers = new Headers(response.headers);
  additional.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function scan(request) {
  const body = await request.json();
  if (typeof body.url !== "string") return json({ error: "Informe uma URL válida." }, 400);
  const initial = normalizePageUrl(body.url);
  const galleryId = nhentaiGalleryId(initial);
  if (galleryId) return json(await scanNhentaiGallery(galleryId, initial));
  const { response, finalUrl } = await safeFetch(initial, {
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.7" },
  });
  if (!response.ok) throw new Error(`O site respondeu com o erro ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text")) {
    throw new Error("O endereço não parece ser uma página HTML.");
  }
  const html = await readHtml(response);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || finalUrl.hostname;
  const extracted = extractImages(html, finalUrl);
  const images = extracted.map((image, index) => ({
    ...image,
    id: `img-${index}-${simpleHash(image.url)}`,
    format: formatFromUrl(image.url),
  }));
  return json({
    pageTitle: htmlDecode(title).slice(0, 180),
    pageUrl: finalUrl.href,
    images,
    notice: extracted.length >= 600 ? "A página contém muitas imagens; mostramos as primeiras 600." : undefined,
  });
}

function nhentaiGalleryId(url) {
  if (!/^(?:www\.)?nhentai\.net$/i.test(url.hostname)) return null;
  return url.pathname.match(/^\/g\/(\d+)\/?$/)?.[1] || null;
}

async function scanNhentaiGallery(id, pageUrl) {
  const endpoint = new URL(`https://nhentai.net/api/v2/galleries/${id}`);
  const { response } = await safeFetch(endpoint, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`A galeria respondeu com o erro ${response.status}.`);
  const gallery = await response.json();
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
  }).filter(Boolean);
  return {
    pageTitle: htmlDecode(String(gallery.title?.english || gallery.title?.japanese || `Galeria ${id}`)).slice(0, 180),
    pageUrl: pageUrl.href,
    images,
    notice: gallery.pages.length > 600 ? "A galeria contém muitas imagens; mostramos as primeiras 600." : undefined,
  };
}

async function proxyImage(request) {
  const value = new URL(request.url).searchParams.get("url");
  if (!value) return json({ error: "URL ausente." }, 400);
  const target = assertPublicUrl(value);
  const { response } = await safeFetch(target, { headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
  if (!response.ok || !response.body) throw new Error("Imagem indisponível.");
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) throw new Error("O endereço não retornou uma imagem.");
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=3600, s-maxage=86400",
    "x-content-type-options": "nosniff",
  });
  const length = response.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(response.body, { headers });
}

async function bundle(request) {
  const raw = await request.json();
  if (!Array.isArray(raw.items) || raw.items.length === 0) return json({ error: "Selecione pelo menos uma imagem." }, 400);
  if (raw.items.length > 120) return json({ error: "Baixe no máximo 120 imagens por arquivo ZIP." }, 400);
  const items = raw.items;
  for (const item of items) {
    if (typeof item.url !== "string" || item.url.length > 700_000) return json({ error: "Uma das imagens possui um endereço inválido." }, 400);
    if (!item.url.startsWith("data:image/")) assertPublicUrl(item.url);
  }

  const stream = createZipStream(async (zip) => {
    const failures = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const url = item.url;
      try {
        if (url.startsWith("data:image/")) {
          const inline = decodeInlineImage(url);
          const name = withExtension(safeFileName(typeof item.name === "string" ? item.name : "imagem", index), inline.contentType, url);
          await zip.add(name, inline.bytes);
          continue;
        }
        const { response } = await safeFetch(assertPublicUrl(url), { headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
        const contentType = response.headers.get("content-type") || "";
        const length = Number(response.headers.get("content-length") || 0);
        if (!response.ok || !response.body || !contentType.toLowerCase().startsWith("image/")) throw new Error("não retornou uma imagem");
        if (length > 100_000_000) throw new Error("arquivo maior que 100 MB");
        const name = withExtension(safeFileName(typeof item.name === "string" ? item.name : "imagem", index), contentType, url);
        await zip.add(name, response.body);
      } catch (error) {
        failures.push(`${index + 1}. ${url.slice(0, 240)} — ${messageOf(error, "falha no download")}`);
      }
    }
    if (failures.length) {
      await zip.add("falhas.txt", new TextEncoder().encode(`Algumas imagens não puderam ser baixadas:\n\n${failures.join("\n")}`));
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": "attachment; filename=\"imagens-capturadas.zip\"",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function htmlDecode(value) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\\\//g, "/").trim();
}

function attributes(raw) {
  const output = {};
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of raw.matchAll(regex)) output[match[1].toLowerCase()] = htmlDecode(match[2] ?? match[3] ?? match[4] ?? "");
  return output;
}

function srcsetCandidates(value) {
  return value.split(",").map((item) => {
    const match = item.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
    if (!match) return null;
    const score = match[3] === "x" ? Number(match[2] || 1) * 10_000 : Number(match[2] || 0);
    return { value: match[1], score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

function bestSrcset(value) {
  return srcsetCandidates(value)[0]?.value || "";
}

function resolveImage(value, base) {
  const decoded = htmlDecode(value).replace(/^['"]|['"]$/g, "");
  if (!decoded || decoded.startsWith("blob:") || decoded.startsWith("javascript:")) return null;
  if (decoded.startsWith("data:image/")) return decoded.length <= 500_000 ? decoded : null;
  try {
    const resolved = new URL(decoded, base);
    return ["http:", "https:"].includes(resolved.protocol) ? resolved.href : null;
  } catch (_) {
    return null;
  }
}

function imageAttributeCandidates(attrs) {
  const candidates = [];
  const add = (value, score) => { if (value) candidates.push({ value, score }); };

  add(attrs["data-orig-file"], 9_000_000);
  add(attrs["data-original-file"], 9_000_000);
  add(attrs["data-full"], 8_000_000);
  add(attrs["data-full-src"], 8_000_000);
  add(attrs["data-zoom-image"], 8_000_000);
  add(attrs["data-hires"], 8_000_000);

  for (const candidate of srcsetCandidates(attrs.srcset || "")) add(candidate.value, 2_000_000 + candidate.score);
  for (const candidate of srcsetCandidates(attrs["data-srcset"] || "")) add(candidate.value, 2_000_000 + candidate.score);

  add(attrs["data-large-file"], 1_500_000);
  add(attrs["data-original"], 1_000_000);
  add(attrs["data-lazy-src"], 500_000);
  add(attrs["data-src"], 400_000);
  add(attrs.src, 100_000);
  return candidates.sort((a, b) => b.score - a.score);
}

function looksLikeImageLink(value, attrs) {
  try {
    const url = new URL(value);
    if (/\.(?:avif|webp|png|jpe?g|gif|svg|bmp|tiff?|ico|heic|heif)$/i.test(url.pathname)) return true;
    if (/^(?:avif|webp|png|jpe?g|gif|svg|bmp|tiff?|ico|heic|heif)$/i.test(url.searchParams.get("format") || url.searchParams.get("fm") || "")) return true;
  } catch (_) {
    return false;
  }
  const hint = [attrs.class, attrs.id, attrs.rel, attrs["data-lightbox"], attrs["data-fancybox"]].filter(Boolean).join(" ");
  return Object.hasOwn(attrs, "download") || /(?:lightbox|fancybox|zoom|full[-_ ]?size)/i.test(hint);
}

function linkedOriginalsFromHtml(html, base) {
  const originals = new Map();
  for (const anchorMatch of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const anchorAttrs = attributes(anchorMatch[1]);
    const originalUrl = resolveImage(anchorAttrs.href || anchorAttrs["data-href"] || "", base);
    if (!originalUrl || !looksLikeImageLink(originalUrl, anchorAttrs)) continue;

    for (const imageMatch of anchorMatch[2].matchAll(/<(img|source)\b([^>]*)>/gi)) {
      const imageAttrs = attributes(imageMatch[2]);
      for (const candidate of imageAttributeCandidates(imageAttrs)) {
        const thumbnailUrl = resolveImage(candidate.value, base);
        if (thumbnailUrl && thumbnailUrl !== originalUrl) originals.set(thumbnailUrl, originalUrl);
      }
    }
  }
  return originals;
}

function bestImageSource(attrs, base, linkedOriginals) {
  const candidates = imageAttributeCandidates(attrs);
  for (const candidate of candidates) {
    const candidateUrl = resolveImage(candidate.value, base);
    const linkedOriginal = candidateUrl ? linkedOriginals.get(candidateUrl) : null;
    if (linkedOriginal) return { value: linkedOriginal, source: "link para imagem original" };
  }
  return candidates[0] ? { value: candidates[0].value, source: "maior variante disponível" } : null;
}

function inferiorImageVariantsFromHtml(html, base, linkedOriginals) {
  const preferredUrls = new Set();
  const inferiorUrls = new Set();
  for (const match of html.matchAll(/<(img|source)\b([^>]*)>/gi)) {
    const attrs = attributes(match[2]);
    const preferred = bestImageSource(attrs, base, linkedOriginals);
    const preferredUrl = preferred ? resolveImage(preferred.value, base) : null;
    if (preferredUrl) preferredUrls.add(preferredUrl);
    for (const candidate of imageAttributeCandidates(attrs)) {
      const candidateUrl = resolveImage(candidate.value, base);
      if (candidateUrl && candidateUrl !== preferredUrl) inferiorUrls.add(candidateUrl);
    }
  }
  for (const preferredUrl of preferredUrls) inferiorUrls.delete(preferredUrl);
  return inferiorUrls;
}

function extractImages(html, base) {
  const found = new Map();
  const linkedOriginals = linkedOriginalsFromHtml(html, base);
  const inferiorVariants = inferiorImageVariantsFromHtml(html, base, linkedOriginals);
  const add = (raw, alt, source) => {
    const resolved = resolveImage(raw, base);
    const url = resolved ? linkedOriginals.get(resolved) || resolved : null;
    if (resolved === url && inferiorVariants.has(resolved)) return;
    if (!url || found.has(url)) return;
    found.set(url, { url, alt: htmlDecode(alt).slice(0, 220), source: url !== resolved ? "link para imagem original" : source, inline: url.startsWith("data:") });
  };

  for (const match of html.matchAll(/<(img|source|meta|link|image)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = attributes(match[2]);
    const alt = attrs.alt || attrs.title || "";
    if (tag === "img") {
      const preferred = bestImageSource(attrs, base, linkedOriginals);
      if (preferred) add(preferred.value, alt, preferred.source);
    } else if (tag === "source") {
      const preferred = bestImageSource(attrs, base, linkedOriginals);
      if (preferred) add(preferred.value, alt, preferred.source);
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

async function readHtml(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 5_000_000) throw new Error("Esta página é grande demais para uma varredura segura.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 5_000_000) {
      await reader.cancel();
      throw new Error("Esta página é grande demais para uma varredura segura.");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function normalizePageUrl(value) {
  const raw = value.trim();
  if (!raw) throw new Error("Informe o endereço de uma página.");
  return assertPublicUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
}

function assertPublicUrl(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); }
  catch (_) { throw new Error("Este endereço não é válido."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use um endereço que comece com http ou https.");
  if (url.username || url.password) throw new Error("Endereços com usuário ou senha não são aceitos.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Use uma página nas portas padrão 80 ou 443.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Endereços locais ou privados não podem ser acessados.");
  if (host.includes(":")) throw new Error("Endereços IPv6 diretos não são aceitos.");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error("Endereço IP inválido.");
    const [a, b] = parts;
    const blocked = a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
    if (blocked) throw new Error("Endereços locais ou privados não podem ser acessados.");
  }
  return url;
}

async function safeFetch(initial, init = {}) {
  let current = assertPublicUrl(initial);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    let response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "CapturaImageScanner/1.0 (+https://github.com/maiconsantossilvah-dot)",
          accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8",
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    current = assertPublicUrl(new URL(location, current));
  }
  throw new Error("A página redirecionou vezes demais.");
}

function formatFromUrl(value, contentType = "") {
  const cleanType = contentType.split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES[cleanType]) return IMAGE_TYPES[cleanType];
  if (value.startsWith("data:image/")) {
    const subtype = value.slice(11).split(/[;,]/)[0].toUpperCase();
    return subtype === "JPEG" ? "JPG" : subtype === "SVG+XML" ? "SVG" : subtype || "IMG";
  }
  try {
    const match = new URL(value).pathname.match(/\.([a-z0-9]{2,6})$/i);
    if (match) return match[1].toUpperCase().replace("JPEG", "JPG");
  } catch (_) {}
  return "IMG";
}

function decodeInlineImage(value) {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]+)$/i);
  if (!match) throw new Error("Imagem incorporada inválida.");
  if (!match[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(match[3])), contentType: match[1] };
  const binary = atob(match[3].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, contentType: match[1] };
}

function withExtension(name, contentType, url) {
  if (/\.[a-z0-9]{2,6}$/i.test(name)) return name;
  const type = contentType.split(";")[0].toLowerCase();
  return `${name}.${EXTENSION_BY_TYPE[type] || formatFromUrl(url, contentType).toLowerCase()}`;
}

function safeFileName(value, index) {
  const fallback = `imagem-${String(index + 1).padStart(3, "0")}`;
  const clean = value.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").trim();
  return `${String(index + 1).padStart(3, "0")}-${(clean || fallback).slice(-150)}`;
}

function simpleHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function messageOf(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function u16(value) { return [value & 255, (value >>> 8) & 255]; }
function u32(value) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }
function bytes(values) { return new Uint8Array(values); }
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}
function updateCrc(current, chunk) {
  let crc = current;
  for (const value of chunk) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function createZipStream(produce) {
  return new ReadableStream({
    async start(controller) {
      const writer = new ZipWriter(controller);
      try { await produce(writer); await writer.close(); }
      catch (error) { controller.error(error); }
    },
  });
}
class ZipWriter {
  constructor(controller) { this.controller = controller; this.offset = 0; this.entries = []; }
  push(chunk) { this.controller.enqueue(chunk); this.offset += chunk.byteLength; }
  async add(nameValue, stream) {
    const name = encoder.encode(nameValue);
    const { time, date } = dosDateTime();
    const entryOffset = this.offset;
    this.push(bytes([...u32(0x04034b50), ...u16(20), ...u16(0x0808), ...u16(0), ...u16(time), ...u16(date), ...u32(0), ...u32(0), ...u32(0), ...u16(name.length), ...u16(0)]));
    this.push(name);
    let crc = 0xffffffff;
    let size = 0;
    if (stream instanceof Uint8Array) {
      crc = updateCrc(crc, stream); size = stream.byteLength; this.push(stream);
    } else {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 100_000_000) { await reader.cancel(); throw new Error("arquivo maior que 100 MB"); }
        crc = updateCrc(crc, value); this.push(value);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    this.push(bytes([...u32(0x08074b50), ...u32(crc), ...u32(size), ...u32(size)]));
    this.entries.push({ name, crc, size, offset: entryOffset, time, date });
  }
  async close() {
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      this.push(bytes([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0808), ...u16(0), ...u16(entry.time), ...u16(entry.date), ...u32(entry.crc), ...u32(entry.size), ...u32(entry.size), ...u16(entry.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(entry.offset)]));
      this.push(entry.name);
    }
    const directorySize = this.offset - directoryOffset;
    this.push(bytes([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(this.entries.length), ...u16(this.entries.length), ...u32(directorySize), ...u32(directoryOffset), ...u16(0)]));
    this.controller.close();
  }
}
