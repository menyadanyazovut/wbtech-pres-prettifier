/* Страница: только UI. Вся механика — в engine/engine.js (контракт:
   RestyleEngine.init(onProgress) и RestyleEngine.convert(arrayBuffer) ->
   {pptx: Uint8Array, remarks: [{slide, action, comment}]}). */
(function () {
  const MAX_FILES = 15;
  const drop = document.getElementById("drop");
  const picker = document.getElementById("picker");
  const statusEl = document.getElementById("status");
  const results = document.getElementById("results");

  const enginePromise = RestyleEngine.init(msg => { statusEl.textContent = msg; });

  drop.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => handle([...picker.files]));
  ["dragover", "dragenter"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => handle([...e.dataTransfer.files]));

  async function handle(files) {
    files = files.filter(f => f.name.toLowerCase().endsWith(".pptx")).slice(0, MAX_FILES);
    if (!files.length) { statusEl.textContent = "Нужны файлы .pptx"; return; }
    statusEl.textContent = "Готовлю движок…";
    try { await enginePromise; } catch (e) {
      statusEl.innerHTML = '<span class="err">Не удалось загрузить движок: ' + e + "</span>"; return;
    }
    for (const f of files) {
      const card = fileCard(f.name);
      results.prepend(card.root);
      try {
        card.state.textContent = "Обрабатываю…";
        const buf = await f.arrayBuffer();
        const t0 = performance.now();
        const { pptx, remarks } = await RestyleEngine.convert(buf);
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        const blob = new Blob([pptx], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
        const a = document.createElement("a");
        a.className = "dl";
        a.href = URL.createObjectURL(blob);
        a.download = f.name.replace(/\.pptx$/i, "") + " — по дизайн-коду.pptx";
        a.textContent = "Скачать исправленный .pptx";
        card.state.innerHTML = '<span class="ok">Готово</span> за ' + sec + " с";
        card.root.appendChild(a);
        card.root.appendChild(remarksTable(remarks));
      } catch (e) {
        card.state.innerHTML = '<span class="err">Ошибка: ' + e + "</span>";
        console.error(e);
      }
    }
    statusEl.textContent = "";
  }

  function fileCard(name) {
    const root = document.createElement("div");
    root.className = "file";
    const h = document.createElement("h3"); h.textContent = name;
    const state = document.createElement("div"); state.className = "state";
    root.append(h, state);
    return { root, state };
  }

  function remarksTable(remarks) {
    const t = document.createElement("table");
    t.innerHTML = "<tr><th>Слайд</th><th>Действие</th><th>Комментарий</th></tr>";
    if (!remarks.length) {
      const tr = t.insertRow();
      tr.insertCell().textContent = "—";
      tr.insertCell().textContent = "замечаний нет";
      tr.insertCell();
      return t;
    }
    remarks.sort((a, b) => a.slide - b.slide);
    for (const r of remarks) {
      const tr = t.insertRow();
      const n = tr.insertCell(); n.className = "n"; n.textContent = r.slide;
      tr.insertCell().textContent = r.action;
      tr.insertCell().textContent = r.comment || "";
    }
    return t;
  }
})();
