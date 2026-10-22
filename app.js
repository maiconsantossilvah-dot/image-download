import { createZipDownloadSession, fetchImageWithRetry, fetchImagesZipPart, uniqueZipItemNames, zipHasAllImages } from "./lib/zip-batches.js";

(function () {
  "use strict";

  const configuredBase = String(window.CAPTURA_API_BASE || "").trim().replace(/\/$/, "");
  const apiReady = configuredBase && !configuredBase.includes("__CLOUDFLARE_WORKER_URL__");
  const apiUrl = (path) => `${configuredBase}${path}`;

  const elements = {
    form: document.querySelector("#scan-form"),
    url: document.querySelector("#url"),
    clearUrl: document.querySelector("#clear-url"),
    scanButton: document.querySelector("#scan-button"),
    progressWrap: document.querySelector("#progress-wrap"),
    progress: document.querySelector("#progress"),
    progressText: document.querySelector("#progress-text"),
    status: document.querySelector("#status"),
    statusText: document.querySelector("#status-text"),
    closeStatus: document.querySelector("#close-status"),
    empty: document.querySelector("#empty"),
    results: document.querySelector("#results"),
    count: document.querySelector("#count"),
    countLabel: document.querySelector("#count-label"),
    sourceHost: document.querySelector("#source-host"),
    format: document.querySelector("#format"),
    selectAll: document.querySelector("#select-all"),
    gallery: document.querySelector("#gallery"),
    noMatches: document.querySelector("#no-matches"),
    downloadBar: document.querySelector("#download-bar"),
    selectedCount: document.querySelector("#selected-count"),
    clearSelection: document.querySelector("#clear-selection"),
    downloadButton: document.querySelector("#download-button"),
    template: document.querySelector("#card-template"),
    viewer: document.querySelector("#viewer"),
    viewerClose: document.querySelector("#viewer-close"),
    viewerPrev: document.querySelector("#viewer-prev"),
    viewerNext: document.querySelector("#viewer-next"),
    viewerImage: document.querySelector("#viewer-image"),
    viewerTitle: document.querySelector("#viewer-title"),
    viewerPosition: document.querySelector("#viewer-position"),
    viewerName: document.querySelector("#viewer-name"),
    viewerDetails: document.querySelector("#viewer-details"),
    viewerOriginal: document.querySelector("#viewer-original"),
    viewerSelect: document.querySelector("#viewer-select"),
  };

  const state = { images: [], selected: new Set(), filter: "TODOS", busy: false, viewerIndex: 0 };
  const downloadSession = createZipDownloadSession();
  let progressTimer = null;

  function showStatus(message, tone = "error") {
    elements.statusText.textContent = message || "";
    elements.status.dataset.tone = tone;
    elements.status.hidden = !message;
  }

  function setBusy(busy, scanLabel = "Buscar imagens") {
    state.busy = busy;
    elements.scanButton.disabled = busy;
    elements.downloadButton.disabled = busy;
    elements.scanButton.querySelector("span").textContent = scanLabel;
    elements.form.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function startProgress() {
    let value = 6;
    elements.progressWrap.hidden = false;
    elements.progress.style.width = `${value}%`;
    elements.progressText.value = `${value}%`;
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      value = Math.min(93, value + Math.max(1, Math.round((95 - value) / 8)));
      elements.progress.style.width = `${value}%`;
      elements.progressText.value = `${value}%`;
    }, 260);
  }

  function finishProgress() {
    clearInterval(progressTimer);
    elements.progress.style.width = "100%";
    elements.progressText.value = "100%";
    window.setTimeout(() => {
      elements.progressWrap.hidden = true;
      elements.progress.style.width = "0";
      elements.progressText.value = "0%";
    }, 380);
  }

  function visibleImages() {
    return state.filter === "TODOS" ? state.images : state.images.filter((item) => item.format === state.filter);
  }

  function displayName(item, index) {
    if (item.alt) return item.alt;
    try {
      const filename = decodeURIComponent(new URL(item.url).pathname.split("/").filter(Boolean).pop() || "");
      return filename || `Imagem ${index + 1}`;
    } catch (_) {
      return `Imagem ${index + 1}`;
    }
  }

  function proxyUrl(item) {
    const url = item.previewUrl || item.url;
    return item.inline ? url : apiUrl(`/api/image?url=${encodeURIComponent(url)}`);
  }

  function fullImageUrl(item) {
    return item.inline ? item.url : apiUrl(`/api/image?url=${encodeURIComponent(item.url)}`);
  }

  function isHighQuality(item) {
    return /original/i.test(item.source || "");
  }

  function updateSelectionUi() {
    const totalSelected = state.selected.size;
    const visible = visibleImages();
    const selectedVisible = visible.filter((item) => state.selected.has(item.id)).length;

    elements.downloadBar.hidden = totalSelected === 0;
    elements.selectedCount.textContent = `${totalSelected} ${totalSelected === 1 ? "imagem selecionada" : "imagens selecionadas"}`;
    elements.selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
    elements.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  }

  function updateCardState(card, item) {
    const selected = state.selected.has(item.id);
    const select = card.querySelector(".image-card__select");
    card.classList.toggle("selected", selected);
    select.setAttribute("aria-pressed", selected ? "true" : "false");
    select.setAttribute("aria-label", `${selected ? "Remover" : "Selecionar"} ${displayName(item, state.images.indexOf(item))}`);
  }

  function renderViewer() {
    const visible = visibleImages();
    const item = visible[state.viewerIndex];
    if (!item) { elements.viewer.close(); return; }
    const name = displayName(item, state.images.indexOf(item));
    elements.viewerTitle.textContent = name;
    elements.viewerPosition.textContent = `${state.viewerIndex + 1} de ${visible.length}`;
    elements.viewerName.textContent = name;
    elements.viewerDetails.textContent = [item.format, item.width && item.height ? `${item.width} × ${item.height} px` : "Tamanho não informado"].join(" · ");
    elements.viewerImage.alt = name;
    const imageUrl = fullImageUrl(item);
    if (elements.viewerImage.src !== imageUrl) elements.viewerImage.src = imageUrl;
    elements.viewerOriginal.href = item.url;
    elements.viewerSelect.textContent = state.selected.has(item.id) ? "✓ Selecionada" : "Selecionar imagem";
    elements.viewerSelect.setAttribute("aria-pressed", state.selected.has(item.id) ? "true" : "false");
    elements.viewerPrev.disabled = state.viewerIndex === 0;
    elements.viewerNext.disabled = state.viewerIndex === visible.length - 1;
  }

  function openViewer(index) {
    state.viewerIndex = index;
    renderViewer();
    elements.viewer.showModal();
  }

  function toggleItem(id) {
    const item = state.images.find((candidate) => candidate.id === id);
    if (!item) return;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    const card = elements.gallery.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card) updateCardState(card, item);
    updateSelectionUi();
    if (elements.viewer.open) renderViewer();
  }

  function renderGallery() {
    const visible = visibleImages();
    elements.gallery.replaceChildren();
    elements.count.textContent = String(visible.length);
    elements.countLabel.textContent = visible.length === 1 ? "imagem encontrada" : "imagens encontradas";
    elements.noMatches.hidden = visible.length > 0;

    visible.forEach((item) => {
      const absoluteIndex = state.images.indexOf(item);
      const fragment = elements.template.content.cloneNode(true);
      const card = fragment.querySelector(".image-card");
      const preview = fragment.querySelector(".image-card__preview");
      const select = fragment.querySelector(".image-card__select");
      const image = fragment.querySelector("img");
      const format = fragment.querySelector(".image-card__format");
      const quality = fragment.querySelector(".image-card__quality");
      const title = fragment.querySelector(".image-card__title");
      const dimensions = fragment.querySelector(".dimensions");
      const original = fragment.querySelector("a");
      const name = displayName(item, absoluteIndex);

      card.dataset.id = item.id;
      image.alt = name;
      image.decoding = "async";
      image.src = proxyUrl(item);
      image.addEventListener("load", () => {
        dimensions.textContent = item.width && item.height ? `${item.width} × ${item.height} px` : `${image.naturalWidth} × ${image.naturalHeight} px`;
      });
      image.addEventListener("error", () => {
        dimensions.textContent = "Prévia indisponível";
        card.classList.add("image-error");
      });
      format.textContent = item.format || "IMG";
      quality.hidden = !isHighQuality(item);
      title.textContent = name;
      title.title = name;
      original.href = item.url;
      preview.setAttribute("aria-label", `Ampliar ${name}`);
      preview.addEventListener("click", () => openViewer(visible.indexOf(item)));
      select.addEventListener("click", () => toggleItem(item.id));
      updateCardState(card, item);
      elements.gallery.appendChild(fragment);
    });
    updateSelectionUi();
  }

  function populateFormats() {
    const formats = [...new Set(state.images.map((item) => item.format || "IMG"))].sort();
    elements.format.replaceChildren(new Option("Todos", "TODOS"));
    formats.forEach((format) => elements.format.add(new Option(format, format)));
    elements.format.value = "TODOS";
    state.filter = "TODOS";
  }

  async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `A solicitação falhou (${response.status}).`);
    return data;
  }

  async function verifyZip(blob) {
    if (blob.size < 22) throw new Error("O download foi interrompido. Tente novamente.");
    const footer = new DataView(await blob.slice(-22).arrayBuffer());
    const directorySize = footer.getUint32(12, true);
    const directoryOffset = footer.getUint32(16, true);
    if (footer.getUint32(0, true) !== 0x06054b50 ||
        footer.getUint16(8, true) === 0 ||
        directoryOffset + directorySize + 22 !== blob.size) {
      throw new Error("O download foi interrompido. Tente novamente.");
    }
    const header = new DataView(await blob.slice(directoryOffset, directoryOffset + 4).arrayBuffer());
    if (header.byteLength !== 4 || header.getUint32(0, true) !== 0x02014b50) {
      throw new Error("O download foi interrompido. Tente novamente.");
    }
  }

  async function scan(event) {
    event.preventDefault();
    if (state.busy) return;
    const pageUrl = elements.url.value.trim();
    if (!pageUrl) {
      elements.url.focus();
      showStatus("Cole o endereço de uma página para começar.");
      return;
    }
    if (!apiReady) {
      showStatus("O endereço da API ainda não foi configurado.");
      return;
    }

    showStatus("");
    setBusy(true, "Procurando…");
    downloadSession.reset();
    startProgress();
    try {
      const data = await fetch(apiUrl("/api/scan"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: pageUrl }),
      }).then(readJson);

      state.images = Array.isArray(data.images) ? data.images : [];
      state.selected.clear();
      populateFormats();
      elements.empty.hidden = true;
      elements.results.hidden = false;
      try {
        const host = new URL(data.pageUrl).hostname.replace(/^www\./, "");
        elements.sourceHost.textContent = `${host} · ${data.pageTitle || "Página analisada"}`;
      } catch (_) {
        elements.sourceHost.textContent = data.pageTitle || "Página analisada";
      }
      renderGallery();

      if (data.notice) showStatus(data.notice, "info");
      else if (!state.images.length) showStatus("Nenhuma imagem foi encontrada no código público dessa página.", "info");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Não foi possível analisar essa página.");
    } finally {
      finishProgress();
      setBusy(false);
    }
  }

  async function downloadSelected() {
    if (!state.selected.size || state.busy) return;
    showStatus("");
    setBusy(true);
    const label = elements.downloadButton.querySelector("span");
    label.textContent = "Preparando ZIP…";
    try {
      const selected = state.images.filter((item) => state.selected.has(item.id));
      const items = uniqueZipItemNames(selected.map((item, index) => ({
        url: item.url,
        name: displayName(item, index),
        format: item.format,
      })));
      const blob = await downloadSession.run(items, (batch, index, total, recovery) => fetchImagesZipPart(batch, (item) =>
        fetchImageWithRetry(item, (url) => apiUrl(`/api/image?url=${encodeURIComponent(url)}`), (attempt, attempts) => {
          label.textContent = `Tentativa ${attempt} de ${attempts}…`;
          showStatus(`Imagem ${item.name} interrompida. Tentando novamente (${attempt}/${attempts})…`, "info");
        }), recovery, (done, count) => {
          label.textContent = `Parte ${index + 1}/${total}: ${done}/${count}…`;
        }), (index, total) => {
        label.textContent = `Preparando parte ${index}/${total}…`;
        showStatus(`Preparando parte ${index} de ${total}…`, "info");
      });
      label.textContent = "Juntando ZIP…";
      await verifyZip(blob);
      if (!await zipHasAllImages(blob, items.length)) throw new Error("O ZIP não contém todas as imagens selecionadas.");
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "imagens-capturadas.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      downloadSession.reset();
      showStatus("Seu arquivo ZIP foi preparado e o download começou.", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível preparar o arquivo ZIP.";
      showStatus(downloadSession.completedCount() ? `${message} O progresso foi mantido. Clique em Baixar ZIP para continuar sem recarregar a página.` : message);
    } finally {
      setBusy(false);
      label.textContent = "Baixar ZIP";
    }
  }

  function updateClearButton() {
    elements.clearUrl.hidden = !elements.url.value;
  }

  elements.form.addEventListener("submit", scan);
  elements.url.addEventListener("input", updateClearButton);
  elements.clearUrl.addEventListener("click", () => {
    elements.url.value = "";
    updateClearButton();
    elements.url.focus();
  });
  elements.closeStatus.addEventListener("click", () => showStatus(""));
  elements.format.addEventListener("change", () => {
    state.filter = elements.format.value;
    renderGallery();
  });
  elements.selectAll.addEventListener("change", () => {
    visibleImages().forEach((item) => elements.selectAll.checked ? state.selected.add(item.id) : state.selected.delete(item.id));
    renderGallery();
  });
  elements.clearSelection.addEventListener("click", () => {
    state.selected.clear();
    renderGallery();
  });
  elements.downloadButton.addEventListener("click", downloadSelected);
  elements.viewerClose.addEventListener("click", () => elements.viewer.close());
  elements.viewerPrev.addEventListener("click", () => { state.viewerIndex -= 1; renderViewer(); });
  elements.viewerNext.addEventListener("click", () => { state.viewerIndex += 1; renderViewer(); });
  elements.viewerSelect.addEventListener("click", () => {
    const item = visibleImages()[state.viewerIndex];
    if (item) toggleItem(item.id);
  });
  elements.viewerImage.addEventListener("error", () => { elements.viewerDetails.textContent = "Prévia indisponível · tente abrir o arquivo"; });
  elements.viewer.addEventListener("click", (event) => {
    if (event.target === elements.viewer) elements.viewer.close();
  });
  elements.viewer.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" && state.viewerIndex > 0) { state.viewerIndex -= 1; renderViewer(); }
    if (event.key === "ArrowRight" && state.viewerIndex < visibleImages().length - 1) { state.viewerIndex += 1; renderViewer(); }
  });
  elements.format.addEventListener("change", () => { if (elements.viewer.open) elements.viewer.close(); });
  updateClearButton();
}());
