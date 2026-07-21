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
      tr.className = "remark";
      const n = tr.insertCell(); n.className = "n";
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "chk";
      chk.title = "Пометить как исправленное";
      const num = document.createElement("span"); num.textContent = r.slide;
      n.append(chk, num);
      tr.insertCell().textContent = r.action;
      tr.insertCell().textContent = r.comment || "";
      chk.addEventListener("change", () => { if (chk.checked) resolveRow(tr); });
    }
    return t;
  }

  // Удалить строку замечания с возможностью отмены через snackbar.
  function resolveRow(tr) {
    const table = tr.parentNode;
    const anchor = tr.nextSibling;                 // куда вернуть при отмене
    table.removeChild(tr);
    showSnack("Комментарий удалён", () => {
      const chk = tr.querySelector(".chk"); if (chk) chk.checked = false;
      if (anchor && anchor.parentNode === table) table.insertBefore(tr, anchor);
      else table.appendChild(tr);
    });
  }

  // ---- snackbar: правый нижний угол, стек максимум из трёх, автоскрытие 2 с ----
  const snacks = document.getElementById("snacks");
  function showSnack(message, onUndo) {
    while (snacks.children.length >= 3) hideSnack(snacks.firstElementChild, true);
    const el = document.createElement("div"); el.className = "snack";
    const span = document.createElement("span"); span.textContent = message;
    const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Отменить";
    el.append(span, btn);
    snacks.appendChild(el);
    el._timer = setTimeout(() => hideSnack(el), 2000);
    btn.addEventListener("click", () => { hideSnack(el, true); if (onUndo) onUndo(); });
  }
  function hideSnack(el, immediate) {
    if (!el || el._removing) return;
    el._removing = true;
    clearTimeout(el._timer);
    if (immediate) { el.remove(); return; }
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => { if (el.parentNode) el.remove(); }, 400);   // подстраховка
  }
})();
