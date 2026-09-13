import { assertPublicUrl, decodeInlineImage, formatFromUrl, safeFetch } from "@/lib/web-security";
import { createZipStream, safeFileName } from "@/lib/zip-stream";

export const runtime = "edge";

type RequestedItem = { url?: unknown; name?: unknown };
const extensionByType: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/heic": "heic", "image/heif": "heif",
};

function withExtension(name: string, contentType: string, url: string) {
  if (/\.[a-z0-9]{2,6}$/i.test(name)) return name;
  const type = contentType.split(";")[0].toLowerCase();
  return `${name}.${extensionByType[type] || formatFromUrl(url, contentType).toLowerCase()}`;
}

export async function POST(request: Request) {
  try {
    const raw = await request.json() as { items?: unknown };
    if (!Array.isArray(raw.items) || raw.items.length === 0) return Response.json({ error: "Selecione pelo menos uma imagem." }, { status: 400 });
    if (raw.items.length > 120) return Response.json({ error: "Baixe no máximo 120 imagens por arquivo ZIP." }, { status: 400 });
    const items = raw.items as RequestedItem[];
    for (const item of items) {
      if (typeof item.url !== "string" || item.url.length > 700_000) return Response.json({ error: "Uma das imagens possui um endereço inválido." }, { status: 400 });
      if (!item.url.startsWith("data:image/")) assertPublicUrl(item.url);
    }

    const stream = createZipStream(async (zip) => {
      const failures: string[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const url = item.url as string;
        try {
          if (url.startsWith("data:image/")) {
            const inline = decodeInlineImage(url);
            const name = withExtension(safeFileName(typeof item.name === "string" ? item.name : "imagem", index), inline.contentType, url);
            await zip.add(name, inline.bytes);
            continue;
          }
          const { response } = await safeFetch(assertPublicUrl(url), { headers: { accept: "*/*" } });
          const contentType = response.headers.get("content-type") || "";
          const length = Number(response.headers.get("content-length") || 0);
          if (!response.ok || !response.body || !contentType.toLowerCase().startsWith("image/")) throw new Error("não retornou uma imagem");
          if (length > 100_000_000) throw new Error("arquivo maior que 100 MB");
          const name = withExtension(safeFileName(typeof item.name === "string" ? item.name : "imagem", index), contentType, url);
          await zip.add(name, response.body);
        } catch (error) {
          failures.push(`${index + 1}. ${url.slice(0, 240)} — ${error instanceof Error ? error.message : "falha no download"}`);
        }
      }
      if (failures.length) await zip.add("falhas.txt", new TextEncoder().encode(`Algumas imagens não puderam ser baixadas:\n\n${failures.join("\n")}`));
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="imagens-capturadas.zip"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Não foi possível preparar o arquivo ZIP." }, { status: 400 });
  }
}
