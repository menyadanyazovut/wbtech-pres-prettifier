/* Страница: только UI. Вся механика — в engine/engine.js (контракт:
   RestyleEngine.init(onProgress) / .convert(buf) / .ready). */
(function () {
  const MAX_FILES = 15;
  const drop = document.getElementById("drop");
  const picker = document.getElementById("picker");
  const statusEl = document.getElementById("status");
  const bootbar = document.getElementById("bootbar");
  const bootfill = bootbar.querySelector("i");
  const results = document.getElementById("results");

  // ---- индикатор загрузки движка ----
  let lastLabel = "старт";
  function bootProgress({ pct, label }) {
    if (label) { statusEl.textContent = label; lastLabel = label; }
    bootbar.classList.add("show");
    if (pct == null) {
      bootbar.classList.add("indet");
    } else {
      bootbar.classList.remove("indet");
      bootfill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
  }

  let bootFailed = false;
  const enginePromise = RestyleEngine.init(bootProgress)
    .then(() => {
      statusEl.innerHTML = '<span class="ok">Движок готов</span> — прикрепляйте файлы .pptx.';
      setTimeout(() => bootbar.classList.remove("show"), 600);
    })
    .catch((e) => {
      bootFailed = true;
      bootbar.classList.remove("show");
      console.error("RestyleEngine.init failed at stage:", lastLabel, e);
      statusEl.innerHTML = '<span class="err">Не удалось загрузить движок</span> (этап: ' + esc(lastLabel) +
        ')<br><small>' + esc(errStr(e)) +
        '</small><br><small>Обновите страницу; если повторяется — пришлите этот текст.</small>';
      throw e;
    });
  // не роняем консоль необработанным реджектом
  enginePromise.catch(() => {});

  drop.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { handle([...picker.files]); picker.value = ""; });
  ["dragover", "dragenter"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => handle([...e.dataTransfer.files]));

  async function handle(fileList) {
    const files = fileList.filter(f => f.name.toLowerCase().endsWith(".pptx")).slice(0, MAX_FILES);
    if (!files.length) { flash("Нужны файлы .pptx"); return; }
    if (bootFailed) { flash("Движок не загрузился — обновите страницу"); return; }

    // карточки создаём сразу — пользователь видит, что файлы приняты,
    // даже если движок ещё догружается (обработка начнётся автоматически).
    const cards = files.map(f => {
      const card = fileCard(f.name);
      results.prepend(card.root);
      card.setBusy(RestyleEngine.ready ? "Обрабатываю…" : "Ждёт загрузки движка…");
      return { f, card };
    });

    try { await enginePromise; } catch (e) { cards.forEach(c => c.card.fail("движок недоступен")); return; }

    for (const { f, card } of cards) {
      try {
        card.setBusy("Обрабатываю…");
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
        card.done('<span class="ok">Готово</span> за ' + sec + " с");
        card.root.appendChild(a);
        card.root.appendChild(remarksTable(remarks));
      } catch (e) {
        console.error(e);
        card.fail(esc(errStr(e)));
      }
    }
  }

  // ---- вспомогательное ----
  function esc(s) { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

  // Надёжно достаём текст из чего угодно (Error / PythonError / объект / строка).
  function errStr(e) {
    if (e == null) return "неизвестная ошибка";
    if (typeof e === "string") return e;
    if (e.message) return (e.name ? e.name + ": " : "") + e.message;
    try { const j = JSON.stringify(e); if (j && j !== "{}") return j; } catch (_) {}
    return String(e);
  }

  function flash(msg) {
    const prev = statusEl.innerHTML;
    statusEl.innerHTML = '<span class="err">' + esc(msg) + "</span>";
    setTimeout(() => { if (RestyleEngine.ready) statusEl.innerHTML = prev; }, 2500);
  }

  function fileCard(name) {
    const root = document.createElement("div");
    root.className = "file";
    const h = document.createElement("h3"); h.textContent = name;
    const state = document.createElement("div"); state.className = "state";
    const bar = document.createElement("div"); bar.className = "bar"; bar.innerHTML = "<i></i>";
    root.append(h, state, bar);
    return {
      root, state,
      setBusy(txt) { state.textContent = txt; bar.classList.add("show", "indet"); },
      done(html) { state.innerHTML = html; bar.classList.remove("show", "indet"); },
      fail(msg) { state.innerHTML = '<span class="err">Ошибка: ' + msg + "</span>"; bar.classList.remove("show", "indet"); },
    };
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
