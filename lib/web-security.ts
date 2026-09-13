const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WEBP", "image/gif": "GIF",
  "image/svg+xml": "SVG", "image/avif": "AVIF", "image/bmp": "BMP", "image/tiff": "TIFF",
  "image/x-icon": "ICO", "image/vnd.microsoft.icon": "ICO", "image/heic": "HEIC", "image/heif": "HEIF",
};

export function normalizePageUrl(value: string) {
  const raw = value.trim();
  if (!raw) throw new Error("Informe o endereço de uma página.");
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return assertPublicUrl(candidate);
}

export function assertPublicUrl(value: string | URL) {
  let url: URL;
  try { url = value instanceof URL ? value : new URL(value); }
  catch { throw new Error("Este endereço não é válido."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Use um endereço que comece com http ou https.");
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

export async function safeFetch(initial: URL, init: RequestInit = {}) {
  let current = assertPublicUrl(initial);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "CapturaImageScanner/1.0 (+https://chatgpt.com)",
          accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8",
          ...(init.headers || {}),
        },
      });
    } finally { clearTimeout(timer); }
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    current = assertPublicUrl(new URL(location, current));
  }
  throw new Error("A página redirecionou vezes demais.");
}

export function formatFromUrl(value: string, contentType = "") {
  const cleanType = contentType.split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES[cleanType]) return IMAGE_TYPES[cleanType];
  if (value.startsWith("data:image/")) {
    const subtype = value.slice(11).split(/[;,]/)[0].toUpperCase();
    return subtype === "JPEG" ? "JPG" : subtype === "SVG+XML" ? "SVG" : subtype || "IMG";
  }
  try {
    const match = new URL(value).pathname.match(/\.([a-z0-9]{2,6})$/i);
    if (match) return match[1].toUpperCase().replace("JPEG", "JPG");
  } catch { /* Keep generic format. */ }
  return "IMG";
}

export function decodeInlineImage(value: string) {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]+)$/i);
  if (!match) throw new Error("Imagem incorporada inválida.");
  if (!match[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(match[3])), contentType: match[1] };
  const binary = atob(match[3].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, contentType: match[1] };
}
