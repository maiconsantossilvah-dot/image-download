(function () {
  "use strict";

  const configuredBase = String(window.CAPTURA_API_BASE || "").trim().replace(/\/$/, "");
  const apiReady = configuredBase && !configuredBase.includes("__CLOUDFLARE_WORKER_URL__");
  const apiUrl = (path) => `${configuredBase}${path}`;

  const elements = {
    form: document.querySelector("#scan-form"),
    url: document.querySelector("#url"),
    scanButton: document.querySelector("#scan-button"),
    progressWrap: document.querySelector("#progress-wrap"),
    progress: document.querySelector("#progress"),
    progressText: document.querySelector("#progress-text"),
    status: document.querySelector("#status"),
    empty: document.querySelector("#empty"),
    results: document.querySelector("#results"),
    count: document.querySelector("#count"),
    countLabel: document.querySelector("#count-label"),
    sourceHost: document.querySelector("#source-host"),
    format: document.querySelector("#format"),
    selectAll: document.querySelector("#select-all"),
    gallery: document.querySelector("#gallery"),
    downloadBar: document.querySelector("#download-bar"),
    selectedCount: document.querySelector("#selected-count"),
    clearSelection: document.querySelector("#clear-selection"),
    downloadButton: document.querySelector("#download-button"),
    template: document.querySelector("#card-template"),
  };

  const state = { images: [], selected: new Set(), filter: "TODOS", busy: false };
  let progressTimer = null;

  function showStatus(message) {
    elements.status.textContent = message || "";
    elements.status.classList.toggle("show", Boolean(message));
  }

  function setBusy(busy, label) {
    state.busy = busy;
    elements.scanButton.disabled = busy;
    elements.downloadButton.disabled = busy;
    elements.scanButton.querySelector("span").textContent = label || "Varrer página";
  }

  function startProgress() {
    let value = 8;
    elements.progressWrap.hidden = false;
    elements.progress.style.width = `${value}%`;
    elements.progressText.value = `${value}%`;
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      value = Math.min(92, value + Math.max(1, Math.round((94 - value) / 7)));
      elements.progress.style.width = `${value}%`;
      elements.progressText.value = `${value}%`;
    }, 280);
  }

  function finishProgress() {
    clearInterval(progressTimer);
    elements.progress.style.width = "100%";
    elements.progressText.value = "100%";
    setTimeout(() => {
      elements.progressWrap.hidden = true;
      elements.progress.style.width = "0";
      elements.progressText.value = "0%";
    }, 420);
  }

  function visibleImages() {
    return state.filter === "TODOS" ? state.images : state.images.filter((item) => item.format === state.filter);
  }

  function displayName(item, index) {
    if (item.alt) return item.alt;
    try {
      const part = decodeURIComponent(new URL(item.url).pathname.split("/").filter(Boolean).pop() || "");
      return part || `Imagem ${index + 1}`;
    } catch (_) {
      return `Imagem ${index + 1}`;
    }
  }

  function proxyUrl(item) {
    return item.inline ? item.url : apiUrl(`/api/image?url=${encodeURIComponent(item.url)}`);
  }

  function updateSelectionUi() {
    const count = state.selected.size;
    elements.downloadBar.hidden = count === 0;
    elements.selectedCount.textContent = `${count} ${count === 1 ? "selecionada" : "selecionadas"}`;
    const visible = visibleImages();
    const selectedVisible = visible.filter((item) => state.selected.has(item.id)).length;
    elements.selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
    elements.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  }

  function toggleItem(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    const card = elements.gallery.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card) card.classList.toggle("selected", state.selected.has(id));
    updateSelectionUi();
  }

  function renderGallery() {
    const visible = visibleImages();
    elements.gallery.replaceChildren();
    elements.count.textContent = String(visible.length);
    elements.countLabel.textContent = visible.length === 1 ? "imagem" : "imagens";

    visible.forEach((item) => {
      const absoluteIndex = state.images.indexOf(item);
      const fragment = elements.template.content.cloneNode(true);
      const card = fragment.querySelector(".card");
      const button = fragment.querySelector(".card__image");
      const image = fragment.querySelector("img");
      const badge = fragment.querySelector(".badge");
      const title = fragment.querySelector(".card__meta p");
      const dimensions = fragment.querySelector(".dimensions");
      const original = fragment.querySelector("a");
      const name = displayName(item, absoluteIndex);

      card.dataset.id = item.id;
      card.classList.toggle("selected", state.selected.has(item.id));
      button.setAttribute("aria-label", `Selecionar ${name}`);
      button.setAttribute("aria-pressed", state.selected.has(item.id) ? "true" : "false");
      image.alt = name;
      image.src = proxyUrl(item);
      image.addEventListener("load", () => { dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight}`; });
      image.addEventListener("error", () => { dimensions.textContent = "prévia indisponível"; });
      badge.textContent = item.format || "IMG";
      title.textContent = name;
      title.title = name;
      original.href = item.url;
      button.addEventListener("click", () => toggleItem(item.id));
      elements.gallery.appendChild(fragment);
    });
    updateSelectionUi();
  }

  function populateFormats() {
    const formats = [...new Set(state.images.map((item) => item.format || "IMG"))].sort();
    elements.format.replaceChildren(new Option("TODOS", "TODOS"));
    formats.forEach((format) => elements.format.add(new Option(format, format)));
    state.filter = "TODOS";
  }

  async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `A solicitação falhou (${response.status}).`);
    return data;
  }

  async function scan(event) {
    event.preventDefault();
    if (state.busy) return;
    showStatus("");
    if (!apiReady) {
      showStatus("O endereço do Cloudflare Worker ainda não foi configurado neste arquivo.");
      return;
    }

    setBusy(true, "Varrendo…");
    startProgress();
    try {
      const data = await fetch(apiUrl("/api/scan"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: elements.url.value }),
      }).then(readJson);

      state.images = Array.isArray(data.images) ? data.images : [];
      state.selected.clear();
      elements.empty.hidden = true;
      elements.results.hidden = false;
      populateFormats();
      try { elements.sourceHost.textContent = `${new URL(data.pageUrl).hostname} · ${data.pageTitle || "página analisada"}`; }
      catch (_) { elements.sourceHost.textContent = data.pageTitle || "Página analisada"; }
      renderGallery();
      if (data.notice) showStatus(data.notice);
      else if (!state.images.length) showStatus("Nenhuma imagem foi encontrada no HTML público dessa página.");
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
    setBusy(true, "Aguarde…");
    elements.downloadButton.innerHTML = "<span aria-hidden=\"true\">↓</span> Preparando…";
    try {
      const items = state.images.filter((item) => state.selected.has(item.id)).map((item, index) => ({
        url: item.url,
        name: displayName(item, index),
      }));
      const response = await fetch(apiUrl("/api/bundle"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!response.ok) await readJson(response);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "imagens-capturadas.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Não foi possível preparar o arquivo ZIP.");
    } finally {
      setBusy(false);
      elements.downloadButton.innerHTML = "<span aria-hidden=\"true\">↓</span> Baixar ZIP";
    }
  }

  elements.form.addEventListener("submit", scan);
  elements.format.addEventListener("change", () => { state.filter = elements.format.value; renderGallery(); });
  elements.selectAll.addEventListener("change", () => {
    visibleImages().forEach((item) => elements.selectAll.checked ? state.selected.add(item.id) : state.selected.delete(item.id));
    renderGallery();
  });
  elements.clearSelection.addEventListener("click", () => { state.selected.clear(); renderGallery(); });
  elements.downloadButton.addEventListener("click", downloadSelected);
}());

