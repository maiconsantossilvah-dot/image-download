import { assertPublicUrl, safeFetch } from "@/lib/web-security";

export const runtime = "edge";

export async function GET(request: Request) {
  try {
    const value = new URL(request.url).searchParams.get("url");
    if (!value) return Response.json({ error: "URL ausente." }, { status: 400 });
    const target = assertPublicUrl(value);
    const { response } = await safeFetch(target, { headers: { accept: "*/*" } });
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
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Imagem indisponível." }, { status: 400 });
  }
}
