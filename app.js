/* Страница: только UI. Вся механика — в engine/engine.js (контракт:
   RestyleEngine.init(onProgress) / .convert(buf) / .ready). */
(function () {
  const MAX_FILES = 15;
  const drop = document.getElementById("drop");
  const picker = document.getElementById("picker");
  const apikey = document.getElementById("apikey");
  const apimodel = document.getElementById("apimodel");
  const keystate = document.getElementById("keystate");

  // ---- настройки Claude API (хранятся только локально) ----
  const K_KEY = "wbtech_claude_key", K_MODEL = "wbtech_claude_model", DEFAULT_MODEL = "claude-sonnet-5";
  function loadSettings() {
    try {
      apikey.value = localStorage.getItem(K_KEY) || "";
      apimodel.value = localStorage.getItem(K_MODEL) || DEFAULT_MODEL;
    } catch (e) { apimodel.value = DEFAULT_MODEL; }
    updateKeyState();
  }
  function saveSettings() {
    try {
      localStorage.setItem(K_KEY, apikey.value.trim());
      localStorage.setItem(K_MODEL, apimodel.value.trim() || DEFAULT_MODEL);
    } catch (e) {}
    updateKeyState();
  }
  function updateKeyState() {
    if (apikey.value.trim()) {
      keystate.textContent = "Ключ сохранён — режим ИИ (переверстка макетов).";
      keystate.className = "hint on";
    } else {
      keystate.textContent = "Без ключа — базовый режим (перенос с фирменным оформлением).";
      keystate.className = "hint";
    }
  }
  function getOpts() {
    return { key: apikey.value.trim(), model: apimodel.value.trim() || DEFAULT_MODEL };
  }
  apikey.addEventListener("input", saveSettings);
  apimodel.addEventListener("input", saveSettings);
  loadSettings();
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
        const opts = getOpts();
        opts.onStage = (msg) => card.setBusy(msg);
        const { pptx, remarks } = await RestyleEngine.convert(buf, opts);
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        const blob = new Blob([pptx], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
        const a = document.createElement("a");
        a.className = "dl";
        a.href = URL.createObjectURL(blob);
        a.download = f.name.replace(/\.pptx$/i, "") + " — по дизайн-коду.pptx";
        a.textContent = "Скачать исправленный .pptx";
        card.done('<span class="ok">Готово</span> за ' + sec + " с");
        card.root.appendChild(a);
        card.root.appendChild(remarksBlock(remarks));
        openTopOnly();   // раскрыт только самый верхний блок в списке
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

  // SVG-галочка (16×16) — серая по умолчанию, зелёная на ховере (через CSS .resolve)
  const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // Свернутый/развёрнутый блок замечаний по одной презентации (нативный <details>).
  function remarksBlock(remarks) {
    const det = document.createElement("details");
    det.className = "remarks";
    const sum = document.createElement("summary");
    const n = remarks.length;
    sum.textContent = n ? "Замечания (" + n + ")" : "Замечаний нет";
    det.appendChild(sum);
    if (n) det.appendChild(remarksTable(remarks, sum));
    return det;
  }

  function remarksTable(remarks, summaryEl) {
    const t = document.createElement("table");
    t.innerHTML = "<tr><th>Слайд</th><th>Действие</th><th>Комментарий</th></tr>";
    remarks.sort((a, b) => a.slide - b.slide);
    const refreshCount = () => {
      const left = t.querySelectorAll("tr.remark").length;
      if (summaryEl) summaryEl.textContent = left ? "Замечания (" + left + ")" : "Все замечания отработаны";
    };
    for (const r of remarks) {
      const tr = t.insertRow();
      tr.className = "remark";
      const n = tr.insertCell(); n.className = "n";
      const num = document.createElement("span"); num.className = "num"; num.textContent = r.slide;
      const btn = document.createElement("span");
      btn.className = "resolve"; btn.innerHTML = CHECK_SVG;
      btn.title = "Пометить как исправленное";
      btn.setAttribute("role", "button"); btn.tabIndex = 0;
      n.append(num, btn);
      tr.insertCell().textContent = r.action;
      tr.insertCell().textContent = r.comment || "";
      const fire = () => resolveRow(tr, refreshCount);
      btn.addEventListener("click", fire);
      btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); } });
    }
    return t;
  }

  // Держим раскрытым только самый верхний блок замечаний в списке результатов.
  function openTopOnly() {
    const blocks = results.querySelectorAll("details.remarks");
    blocks.forEach((d, i) => { d.open = (i === 0); });
  }

  // Удалить строку замечания с возможностью отмены через snackbar.
  function resolveRow(tr, refreshCount) {
    const table = tr.parentNode;
    const anchor = tr.nextSibling;                 // куда вернуть при отмене
    table.removeChild(tr);
    if (refreshCount) refreshCount();
    showSnack("Комментарий удалён", () => {
      const ref = (anchor && anchor.parentNode === table) ? anchor : null;
      table.insertBefore(tr, ref);
      if (refreshCount) refreshCount();
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
