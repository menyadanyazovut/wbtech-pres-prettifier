/* Механика конвертации: Pyodide + engine.py. Единственный публичный контракт:
   RestyleEngine.init(onProgress) -> Promise
   RestyleEngine.convert(arrayBuffer) -> Promise<{pptx: Uint8Array, remarks: Array}>
   Улучшайте engine.py / этот файл свободно — страница про это не знает. */
window.RestyleEngine = (function () {
  const BASE = document.currentScript.src.replace(/engine\.js.*$/, "");
  let pyodide = null;

  async function init(onProgress) {
    if (pyodide) return;
    const say = onProgress || (() => {});
    say("Загружаю Python-движок (≈15 МБ, один раз)…");
    if (!window.loadPyodide) {
      await new Promise((ok, err) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
        s.onload = ok; s.onerror = err;
        document.head.appendChild(s);
      });
    }
    pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" });
    say("Ставлю пакеты (lxml, Pillow, Pygments)…");
    await pyodide.loadPackage(["lxml", "pillow", "pygments"]);
    say("Загружаю шаблон дизайн-кода…");
    const fetchBin = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    pyodide.FS.mkdirTree("assets");
    pyodide.FS.writeFile("assets/guidelines.pptx", await fetchBin(BASE + "assets/guidelines.pptx"));
    pyodide.FS.writeFile("assets/DejaVuSansMono.ttf", await fetchBin(BASE + "assets/DejaVuSansMono.ttf"));
    pyodide.FS.writeFile("assets/DejaVuSansMono-Bold.ttf", await fetchBin(BASE + "assets/DejaVuSansMono-Bold.ttf"));
    const code = await (await fetch(BASE + "engine.py")).text();
    pyodide.FS.writeFile("engine.py", code);
    pyodide.runPython("import engine");
    say("Движок готов.");
  }

  async function convert(arrayBuffer) {
    if (!pyodide) throw new Error("движок не инициализирован");
    pyodide.FS.writeFile("input.pptx", new Uint8Array(arrayBuffer));
    pyodide.runPython(`
import engine, json
_tpl = open("assets/guidelines.pptx","rb").read()
_src = open("input.pptx","rb").read()
_out, _remarks = engine.convert(_tpl, _src)
open("output.pptx","wb").write(_out)
_remarks_json = json.dumps(_remarks, ensure_ascii=False)
`);
    const pptx = pyodide.FS.readFile("output.pptx");
    const remarks = JSON.parse(pyodide.globals.get("_remarks_json"));
    return { pptx, remarks };
  }

  return { init, convert };
})();
