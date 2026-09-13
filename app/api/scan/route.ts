import { formatFromUrl, normalizePageUrl, safeFetch } from "@/lib/web-security";

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
