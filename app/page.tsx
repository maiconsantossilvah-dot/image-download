"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, ExternalLink, FileImage, ImageIcon, LoaderCircle, ScanSearch, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { toast, Toaster } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { createZipDownloadSession, fetchImageWithRetry, fetchImagesZipPart, uniqueZipItemNames, zipHasAllImages } from "@/lib/zip-batches";

type FoundImage = { id: string; url: string; previewUrl?: string; alt: string; format: string; source: string; inline: boolean; width?: number; height?: number };
type ScanResult = { pageTitle: string; pageUrl: string; images: FoundImage[]; notice?: string };
type ImageSize = { width: number; height: number };
const DEMO_FORMATS = ["JPG", "PNG", "WEBP", "SVG"];

async function verifyZip(blob: Blob) {
  const interrupted = () => new Error("O download foi interrompido. Tente novamente.");
  if (blob.size < 22) throw interrupted();
  const footer = new DataView(await blob.slice(-22).arrayBuffer());
  const directorySize = footer.getUint32(12, true);
  const directoryOffset = footer.getUint32(16, true);
  if (footer.getUint32(0, true) !== 0x06054b50 ||
      footer.getUint16(8, true) === 0 ||
      directoryOffset + directorySize + 22 !== blob.size) throw interrupted();
  const header = new DataView(await blob.slice(directoryOffset, directoryOffset + 4).arrayBuffer());
  if (header.byteLength !== 4 || header.getUint32(0, true) !== 0x02014b50) throw interrupted();
}

function previewUrl(image: FoundImage) {
  const url = image.previewUrl || image.url;
  return image.inline ? url : `/api/image?url=${encodeURIComponent(url)}`;
}

function fullImageUrl(image: FoundImage) {
  return image.inline ? image.url : `/api/image?url=${encodeURIComponent(image.url)}`;
}

function hostLabel(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "imagem incorporada"; }
}

function fileName(image: FoundImage, index: number) {
  try {
    const last = decodeURIComponent(new URL(image.url).pathname.split("/").pop() || "");
    if (last.includes(".")) return last;
  } catch { /* Inline image. */ }
  return `imagem-${String(index + 1).padStart(3, "0")}.${image.format.toLowerCase()}`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sizes, setSizes] = useState<Record<string, ImageSize>>({});
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [format, setFormat] = useState("TODOS");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const scanRef = useRef<(value: string) => Promise<ScanResult>>(() => Promise.reject(new Error("Scanner indisponível")));
  const downloadSessionRef = useRef(createZipDownloadSession());
  const downloadRunningRef = useRef(false);

  const runScan = useCallback(async (value = url) => {
    if (downloadRunningRef.current) {
      toast.error("Aguarde o download atual terminar.");
      throw new Error("Download em andamento");
    }
    const cleanUrl = value.trim();
    if (!cleanUrl) {
      toast.error("Cole o endereço de uma página para começar.");
      throw new Error("URL vazia");
    }
    setLoading(true);
    setProgress(12);
    setResult(null);
    downloadSessionRef.current.reset();
    setSelected(new Set());
    setSizes({});
    setFormat("TODOS");
    setViewerIndex(null);
    const timer = window.setInterval(() => setProgress((current) => Math.min(current + Math.max(2, (88 - current) / 7), 88)), 280);
    try {
      const response = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: cleanUrl }) });
      const data = (await response.json()) as ScanResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "Não foi possível analisar esta página.");
      setProgress(100);
      setResult(data);
      toast.success(data.images.length === 1 ? "1 imagem encontrada." : `${data.images.length} imagens encontradas.`);
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao analisar a página.");
      throw error;
    } finally {
      window.clearInterval(timer);
      window.setTimeout(() => setLoading(false), 180);
    }
  }, [url]);

  useEffect(() => { scanRef.current = runScan; }, [runScan]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: "scan_website_images",
      title: "Varrer imagens de uma página",
      description: "Analisa uma página pública e exibe as imagens encontradas na galeria.",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "URL pública completa da página" } }, required: ["url"], additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input: unknown) => {
        const value = (input as { url?: unknown })?.url;
        if (typeof value !== "string" || !value.trim()) throw new Error("Informe uma URL válida.");
        setUrl(value);
        const data = await scanRef.current(value);
        return { pageUrl: data.pageUrl, imageCount: data.images.length };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const formats = useMemo(() => ["TODOS", ...Array.from(new Set(result?.images.map((image) => image.format) || [])).sort()], [result]);
  const visibleImages = useMemo(() => !result ? [] : format === "TODOS" ? result.images : result.images.filter((image) => image.format === format), [format, result]);
  const selectedImages = useMemo(() => result?.images.filter((image) => selected.has(image.id)) || [], [result, selected]);
  const viewerImage = viewerIndex === null ? null : visibleImages[viewerIndex] || null;

  useEffect(() => {
    if (viewerIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewerIndex(null);
      if (event.key === "ArrowLeft") setViewerIndex((current) => current === null ? null : Math.max(0, current - 1));
      if (event.key === "ArrowRight") setViewerIndex((current) => current === null ? null : Math.min(visibleImages.length - 1, current + 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerIndex, visibleImages.length]);

  const toggleImage = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectedVisible = visibleImages.length > 0 && visibleImages.every((image) => selected.has(image.id));
  const toggleVisible = () => setSelected((current) => {
    const next = new Set(current);
    visibleImages.forEach((image) => selectedVisible ? next.delete(image.id) : next.add(image.id));
    return next;
  });

  const downloadSelected = async () => {
    if (!selectedImages.length || downloadRunningRef.current) return;
    downloadRunningRef.current = true;
    setDownloading(true);
    const toastId = toast.loading("Preparando seu arquivo ZIP…");
    try {
      const items = uniqueZipItemNames(selectedImages.map((image, index) => ({
        url: image.url,
        name: fileName(image, index),
        format: image.format,
      })));
      const blob = await downloadSessionRef.current.run(items, (batch, index, total, recovery) => fetchImagesZipPart(batch, (item) =>
        fetchImageWithRetry(item, (url) => `/api/image?url=${encodeURIComponent(url)}`, (attempt, attempts) => {
          toast.loading(`Imagem ${item.name} interrompida. Tentativa ${attempt} de ${attempts}…`, { id: toastId });
        }), recovery, (done, count) => {
          toast.loading(`Parte ${index + 1}/${total}: ${done} de ${count} imagens…`, { id: toastId });
        }), (index, total) => {
        toast.loading(`Preparando parte ${index} de ${total}…`, { id: toastId });
      });
      toast.loading("Juntando as partes do ZIP…", { id: toastId });
      await verifyZip(blob);
      if (!await zipHasAllImages(blob, items.length)) throw new Error("O ZIP não contém todas as imagens selecionadas.");
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "imagens-capturadas.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      downloadSessionRef.current.reset();
      toast.success("Download iniciado.", { id: toastId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha no download.";
      toast.error(downloadSessionRef.current.completedCount() ? `${message} O progresso foi mantido. Clique em Baixar ZIP para continuar sem recarregar a página.` : message, { id: toastId });
    } finally {
      downloadRunningRef.current = false;
      setDownloading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#07110f] text-[#f3f8f4] selection:bg-[#b7f35c] selection:text-[#07110f]">
      <Toaster position="bottom-right" richColors />
      <header className="border-b border-white/10 bg-[#07110f]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-[1480px] items-center justify-between px-4 sm:px-7 lg:px-10">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[#b7f35c] text-[#07110f] shadow-[0_0_30px_rgba(183,243,92,.18)]"><ScanSearch className="size-5" strokeWidth={2.4} /></span>
            <div><p className="text-[1.05rem] font-bold tracking-[-0.03em]">CAPTURA</p><p className="text-xs text-[#8ea39b]">scanner de imagens</p></div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs text-[#aebdb7] sm:flex"><ShieldCheck className="size-3.5 text-[#b7f35c]" />Acesso apenas a páginas públicas</div>
        </div>
      </header>

      <section className="border-b border-white/10 bg-[radial-gradient(circle_at_50%_-30%,rgba(77,193,151,.16),transparent_48%)]">
        <div className="mx-auto max-w-[1480px] px-4 py-10 sm:px-7 sm:py-14 lg:px-10">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_390px] lg:items-end">
            <div>
              <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#b7f35c]"><Sparkles className="size-3.5" /> Alta qualidade, em um só lugar</p>
              <h1 className="max-w-3xl text-4xl font-semibold leading-[1.02] tracking-[-0.055em] sm:text-5xl lg:text-[4.25rem]">Encontre cada imagem.<br /><span className="text-[#8ea39b]">Baixe só o que importa.</span></h1>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 text-sm leading-relaxed text-[#aebdb7]">O scanner procura imagens comuns, versões responsivas, metadados sociais e fundos definidos no código da página.</div>
          </div>
          <form className="mt-9 flex flex-col gap-3 rounded-2xl border border-white/12 bg-[#0c1b17] p-2 shadow-[0_24px_70px_rgba(0,0,0,.25)] sm:flex-row" onSubmit={(event) => { event.preventDefault(); void runScan().catch(() => undefined); }}>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[#6f857c]" />
              <Input aria-label="Endereço da página" className="h-14 border-0 bg-transparent pl-12 pr-12 text-base text-white shadow-none placeholder:text-[#6f857c] focus-visible:ring-0 md:text-base" placeholder="Cole o link da página — exemplo.com/galeria" type="text" inputMode="url" autoComplete="url" value={url} onChange={(event) => setUrl(event.target.value)} />
              {url && !loading ? <button aria-label="Limpar endereço" className="absolute right-2 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-[#8ea39b] hover:bg-white/5 hover:text-white" type="button" onClick={() => setUrl("")}><X className="size-4" /></button> : null}
            </div>
            <Button className="h-14 rounded-xl bg-[#b7f35c] px-7 text-[0.95rem] font-bold text-[#07110f] hover:bg-[#c8ff77] sm:min-w-36" disabled={loading} type="submit">{loading ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}{loading ? "Varrendo…" : "Varrer página"}</Button>
          </form>
          {loading ? <div className="mt-3 flex items-center gap-3 px-1 text-xs text-[#8ea39b]"><Progress className="h-1 flex-1 bg-white/10 [&>div]:bg-[#b7f35c]" value={progress} /><span className="w-10 text-right tabular-nums">{Math.round(progress)}%</span></div> : null}
        </div>
      </section>

      <section className="mx-auto max-w-[1480px] px-4 py-7 sm:px-7 lg:px-10">
        {loading ? <LoadingGrid /> : result ? (
          <>
            <div className="mb-6 flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-baseline gap-3"><h2 className="text-2xl font-semibold tracking-[-0.035em]">{result.images.length} {result.images.length === 1 ? "imagem" : "imagens"}</h2><span className="text-sm text-[#71867d]">em {hostLabel(result.pageUrl)}</span></div>
                {result.notice ? <p className="mt-1 text-sm text-amber-200/75">{result.notice}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative"><span className="sr-only">Filtrar por formato</span><select className="h-10 appearance-none rounded-lg border border-white/10 bg-[#0c1b17] py-0 pl-3 pr-9 text-sm font-medium text-[#d9e4df] outline-none focus:border-[#b7f35c]/60" value={format} onChange={(event) => { setFormat(event.target.value); setViewerIndex(null); }}>{formats.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[#71867d]" /></label>
                <div className="flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 text-sm font-medium text-[#d9e4df] hover:bg-white/[0.08]">
                  <Checkbox id="select-visible" checked={selectedVisible} onCheckedChange={() => toggleVisible()} className="border-[#70857c] data-[state=checked]:border-[#b7f35c] data-[state=checked]:bg-[#b7f35c] data-[state=checked]:text-[#07110f]" />
                  <label className="cursor-pointer select-none" htmlFor="select-visible">{selectedVisible ? "Desmarcar visíveis" : "Selecionar visíveis"}</label>
                </div>
              </div>
            </div>
            {visibleImages.length ? (
              <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4 2xl:columns-5">
                {visibleImages.map((image, index) => {
                  const isSelected = selected.has(image.id);
                  const imageSize = sizes[image.id];
                  return (
                    <article key={image.id} className={`group relative mb-4 break-inside-avoid overflow-hidden rounded-2xl border bg-[#0c1b17] transition-all duration-200 ${isSelected ? "border-[#b7f35c] shadow-[0_0_0_1px_#b7f35c,0_14px_40px_rgba(0,0,0,.25)]" : "border-white/10 hover:-translate-y-0.5 hover:border-white/20"}`}>
                      <button className="relative block w-full cursor-pointer overflow-hidden bg-[#10241e] text-left" type="button" aria-label={`Ampliar ${image.alt || "imagem"}`} onClick={() => setViewerIndex(index)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={previewUrl(image)} alt={image.alt || "Miniatura encontrada na página"} className="max-h-[390px] min-h-44 w-full object-contain transition duration-300 group-hover:scale-[1.015]" loading="lazy" onLoad={(event) => { const target = event.currentTarget; setSizes((current) => ({ ...current, [image.id]: { width: target.naturalWidth, height: target.naturalHeight } })); }} />
                        <span className="absolute bottom-3 left-3 rounded-md bg-[#07110f]/75 px-2 py-1 text-xs text-white opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">Ampliar ↗</span>
                        <span className="absolute right-3 top-3 rounded-md border border-white/15 bg-[#07110f]/70 px-2 py-1 text-[11px] font-bold text-white backdrop-blur-md">{image.format}</span>
                      </button>
                      <button className={`absolute left-3 top-3 grid size-9 place-items-center rounded-full border backdrop-blur-md transition ${isSelected ? "border-[#b7f35c] bg-[#b7f35c] text-[#07110f]" : "border-white/25 bg-[#07110f]/80 text-transparent hover:text-white"}`} type="button" aria-pressed={isSelected} aria-label={`${isSelected ? "Desmarcar" : "Selecionar"} ${image.alt || "imagem"}`} onClick={() => toggleImage(image.id)}><Check className="size-4" strokeWidth={3} /></button>
                      <div className="p-3.5"><p className="truncate text-sm font-medium text-[#e9f1ed]" title={image.alt || fileName(image, index)}>{image.alt || fileName(image, index)}</p><div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#71867d]"><span>{image.width && image.height ? `${image.width} × ${image.height}` : imageSize ? `${imageSize.width} × ${imageSize.height}` : "medindo…"}</span>{!image.inline ? <a href={image.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-[#b7f35c]" onClick={(event) => event.stopPropagation()}>original <ExternalLink className="size-3" /></a> : <span>incorporada</span>}</div></div>
                    </article>
                  );
                })}
              </div>
            ) : <NoFilteredImages />}
          </>
        ) : <EmptyState />}
      </section>

      {selected.size > 0 ? <div className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-[calc(100%-24px)] max-w-xl items-center justify-between gap-4 rounded-2xl border border-white/15 bg-[#11231e]/95 p-3 pl-4 shadow-[0_20px_70px_rgba(0,0,0,.55)] backdrop-blur-xl"><div className="min-w-0"><p className="font-semibold text-white">{selected.size} {selected.size === 1 ? "selecionada" : "selecionadas"}</p><button className="text-xs text-[#8ea39b] hover:text-white" onClick={() => setSelected(new Set())}>Limpar seleção</button></div><Button className="h-12 rounded-xl bg-[#b7f35c] px-5 font-bold text-[#07110f] hover:bg-[#c8ff77]" disabled={downloading} onClick={() => void downloadSelected()}>{downloading ? <LoaderCircle className="animate-spin" /> : <Download />}Baixar ZIP</Button></div> : null}
      {viewerImage ? <div className="fixed inset-0 z-[60] grid place-items-center bg-black/85 p-2 backdrop-blur-sm sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewerIndex(null); }}><div className="flex max-h-[calc(100vh-16px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/20 bg-[#0c1b17] shadow-2xl sm:max-h-[calc(100vh-40px)]" role="dialog" aria-modal="true" aria-label={`Visualizar ${viewerImage.alt}`}><div className="flex items-center justify-between gap-4 border-b border-white/10 p-3 sm:p-4"><div className="min-w-0"><strong className="block truncate text-sm">{viewerImage.alt || fileName(viewerImage, viewerIndex || 0)}</strong><span className="text-xs text-[#8ea39b]">{(viewerIndex || 0) + 1} de {visibleImages.length}</span></div><button className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/10 text-xl" type="button" aria-label="Fechar visualização" onClick={() => setViewerIndex(null)}>×</button></div><div className="flex min-h-0 flex-1 items-center justify-between gap-1 bg-[#07110f] p-2"><button className="h-12 w-8 shrink-0 rounded-lg border border-white/15 text-2xl disabled:opacity-30 sm:w-11" type="button" aria-label="Imagem anterior" disabled={viewerIndex === 0} onClick={() => setViewerIndex((current) => current === null ? null : current - 1)}>‹</button>{/* eslint-disable-next-line @next/next/no-img-element */}<img className="max-h-[72vh] min-h-0 w-[calc(100%-80px)] object-contain" src={fullImageUrl(viewerImage)} alt={viewerImage.alt} /><button className="h-12 w-8 shrink-0 rounded-lg border border-white/15 text-2xl disabled:opacity-30 sm:w-11" type="button" aria-label="Próxima imagem" disabled={viewerIndex === visibleImages.length - 1} onClick={() => setViewerIndex((current) => current === null ? null : current + 1)}>›</button></div><div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 p-3 sm:p-4"><span className="text-xs text-[#8ea39b]">{viewerImage.format}{viewerImage.width && viewerImage.height ? ` · ${viewerImage.width} × ${viewerImage.height} px` : ""}</span><div className="flex items-center gap-3"><a className="text-xs text-[#b4c2bc]" href={viewerImage.url} target="_blank" rel="noreferrer">Abrir arquivo ↗</a><Button className="bg-[#b7f35c] font-bold text-[#07110f] hover:bg-[#c8ff77]" onClick={() => toggleImage(viewerImage.id)}>{selected.has(viewerImage.id) ? "✓ Selecionada" : "Selecionar imagem"}</Button></div></div></div></div> : null}
    </main>
  );
}

function NoFilteredImages() {
  return <div className="grid min-h-[360px] place-items-center rounded-3xl border border-dashed border-white/12 bg-white/[0.02] p-8 text-center"><div><FileImage className="mx-auto size-10 text-[#71867d]" /><h2 className="mt-4 text-xl font-semibold">Nenhuma imagem neste formato</h2><p className="mt-2 text-sm text-[#8ea39b]">Escolha outro filtro para continuar.</p></div></div>;
}

function EmptyState() {
  return (
    <div className="grid min-h-[390px] overflow-hidden rounded-3xl border border-white/10 bg-[#0a1714] md:grid-cols-[0.9fr_1.1fr]">
      <div className="flex flex-col justify-center p-7 sm:p-10 lg:p-14"><span className="mb-5 grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-[#b7f35c]"><ImageIcon className="size-6" /></span><h2 className="text-2xl font-semibold tracking-[-0.035em]">Sua galeria aparece aqui</h2><p className="mt-3 max-w-md text-base leading-relaxed text-[#8ea39b]">Cole o link de uma página pública. Depois, marque as miniaturas que quiser e receba tudo em um único arquivo ZIP.</p><div className="mt-7 flex flex-wrap gap-2">{DEMO_FORMATS.map((item) => <span key={item} className="rounded-md border border-white/10 bg-white/[0.035] px-2.5 py-1 text-xs font-semibold text-[#8ea39b]">{item}</span>)}<span className="rounded-md border border-[#b7f35c]/20 bg-[#b7f35c]/5 px-2.5 py-1 text-xs font-semibold text-[#b7f35c]">+ outros</span></div></div>
      <div className="relative min-h-64 overflow-hidden border-t border-white/10 bg-[linear-gradient(135deg,#10251e,#08120f)] md:border-l md:border-t-0"><div className="absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.06)_1px,transparent_1px)] [background-size:42px_42px]" /><div className="absolute inset-x-[8%] top-[12%] grid grid-cols-3 gap-3 rotate-[-3deg]">{["h-36", "h-48", "h-40", "h-52", "h-36", "h-48"].map((height, index) => <div key={index} className={`${height} rounded-xl border border-white/10 bg-white/[0.045] p-2 shadow-xl`}><div className="h-full rounded-lg bg-[radial-gradient(circle_at_30%_25%,rgba(183,243,92,.2),transparent_28%),linear-gradient(145deg,rgba(73,170,136,.15),rgba(255,255,255,.025))]" /></div>)}</div><div className="scan-line absolute inset-x-0 h-px bg-[#b7f35c] shadow-[0_0_24px_4px_rgba(183,243,92,.55)]" /></div>
    </div>
  );
}

function LoadingGrid() {
  return <div><div className="mb-6 flex items-center justify-between border-b border-white/10 pb-5"><Skeleton className="h-8 w-48 bg-white/[0.06]" /><Skeleton className="h-10 w-56 bg-white/[0.06]" /></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{[0, 1, 2, 3, 4, 5, 6, 7].map((item) => <div key={item} className="overflow-hidden rounded-2xl border border-white/10 bg-[#0c1b17]"><Skeleton className={`rounded-none bg-white/[0.06] ${item % 3 === 0 ? "h-72" : item % 2 === 0 ? "h-52" : "h-60"}`} /><div className="space-y-2 p-4"><Skeleton className="h-4 w-3/4 bg-white/[0.06]" /><Skeleton className="h-3 w-1/2 bg-white/[0.06]" /></div></div>)}</div></div>;
}
