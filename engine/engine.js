/* Механика конвертации: Pyodide + engine.py. Публичный контракт:
     RestyleEngine.init(onProgress)   -> Promise (резолвится, когда движок готов)
     RestyleEngine.convert(buf)       -> Promise<{pptx: Uint8Array, remarks: Array}>
     RestyleEngine.ready              -> boolean
   onProgress получает {pct, label}: pct = 0..100 или null (неопределённый прогресс).
   Улучшайте engine.py / этот файл свободно — страница знает только про этот контракт. */
window.RestyleEngine = (function () {
  const BASE = document.currentScript.src.replace(/engine\.js.*$/, "");
  const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
  const ASSETS = [
    { path: "assets/guidelines.pptx", url: BASE + "assets/guidelines.pptx", big: true },
    { path: "assets/DejaVuSansMono.ttf", url: BASE + "assets/DejaVuSansMono.ttf" },
    { path: "assets/DejaVuSansMono-Bold.ttf", url: BASE + "assets/DejaVuSansMono-Bold.ttf" },
    { path: "engine.py", url: BASE + "engine.py", text: true },
  ];

  let pyodide = null;
  let initPromise = null;
  const api = { init, convert, get ready() { return !!pyodide; } };

  // Достаём осмысленный текст из любого значения (Error / PythonError / объект).
  function msgOf(e) {
    if (e == null) return "неизвестная ошибка";
    if (typeof e === "string") return e;
    if (e.message) return e.message;
    try { const j = JSON.stringify(e); if (j && j !== "{}") return j; } catch (_) {}
    return String(e);
  }
  // Await с меткой этапа: любая ошибка становится Error("этап: причина").
  async function step(label, promise) {
    try { return await promise; }
    catch (e) { throw new Error(label + ": " + msgOf(e)); }
  }

  function loadScript(src) {
    return new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok;
      s.onerror = () => err(new Error("не удалось загрузить " + src));
      document.head.appendChild(s);
    });
  }

  // Скачивание с реальным прогрессом по Content-Length (для крупного шаблона).
  async function fetchWithProgress(url, onFrac) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status + " на " + url);
    const total = +resp.headers.get("Content-Length") || 0;
    if (!resp.body || !total) return new Uint8Array(await resp.arrayBuffer());
    const reader = resp.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (onFrac) onFrac(got / total);
    }
    const out = new Uint8Array(got); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Ассеты качаются ПАРАЛЛЕЛЬНО с загрузкой Pyodide, чтобы не ждать последовательно.
  function fetchAssets(onTemplateFrac) {
    return Promise.all(ASSETS.map(async (a) => {
      const bytes = a.big
        ? await fetchWithProgress(a.url, onTemplateFrac)
        : new Uint8Array(await (await fetch(a.url)).arrayBuffer());
      return { path: a.path, text: a.text, bytes };
    }));
  }

  async function init(onProgress) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const say = (pct, label) => { try { onProgress && onProgress({ pct, label }); } catch (e) {} };
      try {
        say(3, "Загружаю среду выполнения…");
        // старт скачивания ассетов сразу, параллельно с Pyodide
        let tplFrac = 0;
        const assetsP = fetchAssets((f) => {
          tplFrac = f;
          // пока идёт основная загрузка — шаблон отражаем в диапазоне 72..96%
          if (pyodide) say(72 + Math.round(f * 24), "Загружаю шаблон дизайн-кода… " + Math.round(f * 100) + "%");
        });

        if (!window.loadPyodide) await step("загрузка pyodide.js", loadScript(PYODIDE + "pyodide.js"));
        say(10, "Инициализирую Python…");
        pyodide = await step("инициализация Python", loadPyodide({ indexURL: PYODIDE }));

        say(52, "Устанавливаю библиотеки (lxml, Pillow, Pygments)…");
        await step("установка библиотек", pyodide.loadPackage(["lxml", "pillow", "pygments"]));

        say(72, "Загружаю шаблон дизайн-кода… " + Math.round(tplFrac * 100) + "%");
        const assets = await step("загрузка шаблона", assetsP);   // чаще всего уже скачано за время загрузки Pyodide

        say(97, "Готовлю движок…");
        // ВАЖНО: FS.mkdirTree и FS.writeFile по-разному разрешают относительные пути
        // (mkdirTree — от корня, writeFile — от cwd Python), поэтому пишем ТОЛЬКО
        // по абсолютным путям в рабочий каталог, где engine.py открывает файлы относительно.
        const CWD = pyodide.runPython("import os; os.getcwd()");
        pyodide.FS.mkdirTree(CWD + "/assets");
        for (const a of assets) {
          pyodide.FS.writeFile(CWD + "/" + a.path, a.text ? new TextDecoder().decode(a.bytes) : a.bytes);
        }
        await step("импорт engine.py", Promise.resolve().then(() => pyodide.runPython("import engine")));
        say(100, "Готово");
      } catch (e) {
        pyodide = null;                       // разрешить повторную попытку
        initPromise = null;
        throw e;
      }
    })();
    return initPromise;
  }

  // ---- LLM-режим: Claude выбирает макет и переписывает текст (свой ключ) ----
  const LAYOUT_SYSTEM =
`Ты — редактор-верстальщик образовательных презентаций WB Техношколы. На входе — слайды
исходной презентации преподавателя (массив с индексами, заголовками, текстами, числом
картинок/таблиц). Твоя задача: для КАЖДОГО слайда выбрать фирменный макет и переписать
содержимое в его слоты, СОХРАНЯЯ смысл и формулировки автора. Ничего не выдумывай и не
добавляй фактов; можно только реструктурировать, разбить слипшийся текст на заголовок и
описание, поправить очевидные опечатки и пробелы. Переводить не нужно.

Доступные макеты (верни JSON-массив, по одному объекту на ВЫХОДНОЙ слайд, по порядку):
- {"layout":"title","title":"...","subtitle":"...","number":"01"} — титул (обычно слайд 0).
- {"layout":"tiles","title":"...","tiles":[{"head":"...","body":"..."}]} — 2–6 плиток для
  набора «понятие → короткое пояснение». Идеально для списков определений/категорий.
- {"layout":"img_cols","title":"...","src_slide":N,"columns":[{"head":"...","items":["...","..."]}]}
  — когда на слайде ОДНА главная картинка и текст рядом. src_slide = индекс исходного
  слайда, откуда взять картинку. 1–2 колонки.
- {"layout":"text_cols","title":"...","left":[{"head":"...","body":"..."}],"right":[...]}
  — две смысловые колонки текста (например «Regularizers» / «Reducers»).
- {"layout":"big_text","title":"...","blocks":[{"head":"...","body":"..."}]} — 1–3 крупных
  блока «подзаголовок + абзац».
- {"layout":"canvas","src_slide":N} — ЗАПАСНОЙ: сложные схемы, формулы, скриншоты, код,
  графики — всё, что нельзя аккуратно переверстать текстом. Переносим слайд как есть, но с
  фирменным заголовком и оформлением. Формулы/диаграммы НЕ переписывай — используй canvas.
- {"layout":"questions"} — слайд «Вопросы». {"layout":"thanks"} — «Спасибо».

Правила: слайд 0 обычно → title. Если в конце нет «Вопросы»/«Спасибо» — можешь добавить их.
Для слайда, где есть картинки/формулы/код и мало структурированного текста → canvas.
При сомнении → canvas. Верни ТОЛЬКО JSON-массив, без пояснений и без markdown-ограждений.`;

  async function callLLM(slides, provider, model, key, say) {
    say && say("Нейросеть выбирает макеты и переписывает текст…");
    const userMsg = "Слайды исходной презентации:\n" + JSON.stringify(slides);
    let text;
    if (provider === "anthropic") {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: model || "claude-sonnet-5", max_tokens: 8000, system: LAYOUT_SYSTEM,
          messages: [{ role: "user", content: userMsg }],
        }),
      });
      if (!resp.ok) throw new Error("Anthropic " + resp.status + ": " + (await safeText(resp)));
      const data = await resp.json();
      text = (data.content || []).map((c) => c.text || "").join("");
    } else {
      // OpenRouter (OpenAI-совместимый) — через него идут DeepSeek/Qwen из браузера
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer " + key,
          "HTTP-Referer": location.origin,
          "X-Title": "WB Prettifier",
        },
        body: JSON.stringify({
          model: model, max_tokens: 8000,
          messages: [
            { role: "system", content: LAYOUT_SYSTEM },
            { role: "user", content: userMsg },
          ],
        }),
      });
      if (!resp.ok) throw new Error("OpenRouter " + resp.status + ": " + (await safeText(resp)));
      const data = await resp.json();
      if (data.error) throw new Error("OpenRouter: " + (data.error.message || JSON.stringify(data.error)));
      text = (((data.choices || [])[0] || {}).message || {}).content || "";
    }
    text = (text || "").trim();
    const m = text.match(/\[[\s\S]*\]/);        // вырезаем JSON из возможного обрамления
    if (!m && !text) throw new Error("пустой ответ модели");
    return JSON.parse(m ? m[0] : text);
  }
  async function safeText(resp) { try { return (await resp.text()).slice(0, 300); } catch (e) { return ""; } }

  async function convert(arrayBuffer, opts) {
    if (!pyodide) throw new Error("движок не инициализирован");
    opts = opts || {};
    const say = opts.onStage || null;
    pyodide.FS.writeFile("input.pptx", new Uint8Array(arrayBuffer));

    let planJson = "null";
    const useLLM = !!(opts.key && opts.provider);   // ИИ только при распознанном ключе
    if (useLLM) {
      const slidesJson = pyodide.runPython(
        "import engine, json; json.dumps(engine.extract_for_llm(open('input.pptx','rb').read()), ensure_ascii=False)"
      );
      const slides = JSON.parse(slidesJson);
      const plan = await callLLM(slides, opts.provider || "anthropic", opts.model, opts.key, say);
      planJson = JSON.stringify(plan);
    }
    if (say) say("Собираю презентацию по дизайн-коду…");

    pyodide.globals.set("_plan_json", planJson);
    pyodide.runPython(`
import engine, json, traceback
try:
    _tpl = open("assets/guidelines.pptx","rb").read()
    _src = open("input.pptx","rb").read()
    _plan = json.loads(_plan_json) if _plan_json and _plan_json != "null" else None
    _out, _remarks = engine.convert(_tpl, _src, plan=_plan)
    open("output.pptx","wb").write(_out)
    _remarks_json = json.dumps(_remarks, ensure_ascii=False)
    _error = ""
except Exception:
    _error = traceback.format_exc()
    _remarks_json = "[]"
`);
    const err = pyodide.globals.get("_error");
    if (err) throw new Error(err.split("\n").filter(Boolean).slice(-1)[0] || "ошибка обработки");
    const pptx = pyodide.FS.readFile("output.pptx");
    const remarks = JSON.parse(pyodide.globals.get("_remarks_json"));
    return { pptx, remarks };
  }

  return api;
})();
