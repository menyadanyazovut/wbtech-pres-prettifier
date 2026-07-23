/* Страница: только UI. Вся механика — в engine/engine.js (контракт:
   RestyleEngine.init(onProgress) / .convert(buf) / .ready). */
(function () {
  const MAX_FILES = 15;
  const drop = document.getElementById("drop");
  const picker = document.getElementById("picker");
  const modelSel = document.getElementById("model");
  const apikey = document.getElementById("apikey");
  const modelid = document.getElementById("modelid");
  const keystate = document.getElementById("keystate");
  const keylabel = document.getElementById("keylabel");
  const keyhelp = document.getElementById("keyhelp");

  // ---- модели/провайдеры (ключ нужен для всех; хранится только локально) ----
  // Значение опции: "an:<id>" — Anthropic, "or:<slug>" — OpenRouter.
  // Список бесплатных моделей подгружается ЖИВЫМ из OpenRouter (слоги меняются еженедельно).
  const KEY_HELP = {
    openrouter: 'Ключ OpenRouter (бесплатно): <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> → войдите → Create key. Начинается с <code>sk-or-</code>. Выбранные модели помечены как бесплатные и не списывают деньги (лимиты ~20 запросов/мин).',
    anthropic:  'Ключ Anthropic (платно): <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com → Settings → API keys</a> → Create key. Начинается с <code>sk-ant-</code>. Нужен аккаунт с пополненным балансом.',
  };
  const KEY_PH = { openrouter: "sk-or-...", anthropic: "sk-ant-..." };
  const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  const keybox = document.getElementById("keybox");
  // Модели Puter — работают БЕЗ ключа (User-Pays). Значение "pu:<slug>".
  const PUTER_MODELS = [
    ["anthropic/claude-sonnet-5", "Claude Sonnet 5 — без ключа (лучшее качество)"],
    ["google/gemini-3.1-pro-preview", "Gemini 3.1 Pro — без ключа"],
    ["openai/gpt-5.4-nano", "GPT-5.4 nano — без ключа (быстро)"],
    ["x-ai/grok-4.5", "Grok 4.5 — без ключа"],
  ];
  function curModel() {
    const v = modelSel.value || "pu:anthropic/claude-sonnet-5";
    const provider = v.startsWith("pu:") ? "puter" : v.startsWith("an:") ? "anthropic" : "openrouter";
    return { provider, keytype: provider, id: v.slice(3) };
  }
  function applyModel() {
    const m = curModel();
    if (m.provider === "puter") {
      keybox.style.display = "none";
      keystate.textContent = "Работает без ключа через Puter (при первом запуске — бесплатный вход в Puter).";
      keystate.className = "hint on";
      modelid.value = lsGet("wbtech_id_" + modelSel.value) || m.id;
      return;
    }
    keybox.style.display = "";
    apikey.value = lsGet("wbtech_key_" + m.keytype);
    apikey.placeholder = KEY_PH[m.keytype];
    modelid.value = lsGet("wbtech_id_" + modelSel.value) || m.id;
    keyhelp.innerHTML = KEY_HELP[m.keytype];
    updateKeyState();
  }
  function saveSettings() {
    lsSet("wbtech_model", modelSel.value);
    lsSet("wbtech_key_" + curModel().keytype, apikey.value.trim());
    lsSet("wbtech_id_" + modelSel.value, modelid.value.trim());
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
    const m = curModel();
    return { provider: m.provider, key: apikey.value.trim(), model: modelid.value.trim() || m.id };
  }

  // Группа Puter (без ключа) — добавляется сразу, наверх списка.
  function addPuterGroup() {
    if (modelSel.querySelector('optgroup[label="Без ключа (Puter)"]')) return;
    const g = document.createElement("optgroup"); g.label = "Без ключа (Puter)";
    for (const [slug, label] of PUTER_MODELS) {
      const o = document.createElement("option"); o.value = "pu:" + slug; o.textContent = label;
      g.appendChild(o);
    }
    modelSel.insertBefore(g, modelSel.firstChild);
  }

  // Подтянуть актуальные бесплатные модели OpenRouter (публичный эндпоинт, ключ не нужен).
  async function loadFreeModels() {
    let free = [];
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      const d = await r.json();
      free = (d.data || []).filter((m) => {
        const p = m.pricing || {};
        return Number(p.prompt) === 0 && Number(p.completion) === 0;
      });
      // осмысленные для нашей задачи: инструктивные/чат, приличный контекст; вперёд Qwen
      free = free.filter((m) => !/vision|image|tts|embed|guard|rerank/i.test(m.id));
      free.sort((a, b) => {
        const qa = /qwen/i.test(a.id) ? 0 : 1, qb = /qwen/i.test(b.id) ? 0 : 1;
        if (qa !== qb) return qa - qb;
        return (a.name || a.id).localeCompare(b.name || b.id);
      });
    } catch (e) { free = []; }

    // убрать прежние динамические опции OpenRouter (Puter-группа и Claude остаются)
    [...modelSel.querySelectorAll("option[data-free]")].forEach((n) => n.remove());
    const oldg = modelSel.querySelector('optgroup[label="Свой ключ: бесплатные (OpenRouter)"]');
    if (oldg) oldg.remove();
    if (free.length) {
      const g = document.createElement("optgroup"); g.label = "Свой ключ: бесплатные (OpenRouter)";
      for (const m of free.slice(0, 30)) {
        const o = document.createElement("option");
        o.value = "or:" + m.id; o.textContent = (m.name || m.id) + " — свой ключ OpenRouter";
        o.setAttribute("data-free", "1");
        g.appendChild(o);
      }
      modelSel.appendChild(g);
    }
    // восстановить сохранённый выбор, если он ещё в списке
    const saved = lsGet("wbtech_model");
    if (saved && modelSel.querySelector('option[value="' + CSS.escape(saved) + '"]')) {
      modelSel.value = saved;
      applyModel();
    }
  }

  modelSel.addEventListener("change", () => { lsSet("wbtech_model", modelSel.value); applyModel(); });
  apikey.addEventListener("input", saveSettings);
  modelid.addEventListener("input", saveSettings);
  addPuterGroup();       // модели без ключа — сразу, наверх
  const savedM = lsGet("wbtech_model");
  modelSel.value = (savedM && modelSel.querySelector('option[value="' + CSS.escape(savedM) + '"]'))
    ? savedM : "pu:anthropic/claude-sonnet-5";   // по умолчанию — без ключа
  applyModel();
  loadFreeModels();      // подтянуть OpenRouter-модели для варианта «свой ключ»
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
