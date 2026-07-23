# -*- coding: utf-8 -*-
"""WB Техношкола — универсальный движок приведения .pptx к дизайн-коду.

Чистый Python поверх lxml (+ опционально Pillow/Pygments для код-карточек).
Вся работа с файлами — в памяти (zip-байты на входе и выходе), поэтому движок
одинаково работает в CPython и в Pyodide (браузер, GitHub Pages).

Контракт: convert(template_bytes, src_bytes) -> (pptx_bytes, remarks)
  remarks: [{"slide": int, "action": str, "comment": str}]

Версия v1 (эвристики, без LLM): титул, рестайл всех контентных слайдов
(шрифты/цвета/типографика/солвер наездов/код-карточки), добавление
обязательных слайдов «Вопросы» и «Спасибо». Улучшения (LLM-классификация
макетов, vision для скриншотов кода, генерация «Плана урока») подключаются
здесь, не затрагивая фронтенд.
"""
import io, re, copy, zipfile, posixpath, base64

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
RELNS = "http://schemas.openxmlformats.org/package/2006/relationships"
CTNS = "http://schemas.openxmlformats.org/package/2006/content-types"
IMG_T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
LNK_T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
SLIDE_T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
SLIDE_CT = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"

from lxml import etree
def q(tag):
    p, t = tag.split(":"); return f"{{{NS[p]}}}{t}"

W, H = 9144000, 5143500
TITLE_X = 67675
DONOR_TITLE, DONOR_CANVAS, DONOR_QUESTIONS, DONOR_THANKS = 37, 16, 21, 106

# ---------- код-карточки (опционально) ----------
FONT_PATHS = {"regular": "assets/DejaVuSansMono.ttf", "bold": "assets/DejaVuSansMono-Bold.ttf"}
try:
    from PIL import Image, ImageDraw, ImageFont
    from pygments import lex
    from pygments.lexers import get_lexer_by_name
    from pygments.styles import get_style_by_name
    HAS_CARDS = True
except Exception:
    HAS_CARDS = False

def render_code_card(code, lang="python", font_size=30, pad=56):
    style = get_style_by_name("one-dark")
    lexer = get_lexer_by_name(lang)
    font = ImageFont.truetype(FONT_PATHS["regular"], font_size)
    font_b = ImageFont.truetype(FONT_PATHS["bold"], font_size)
    char_w = font.getlength("M"); line_h = int(font_size * 1.5)
    lines, cur = [], []
    for tok, val in lex(code.rstrip("\n"), lexer):
        st = style.style_for_token(tok)
        color = tuple(int(st["color"][i:i+2], 16) for i in (0, 2, 4)) if st["color"] else (200, 205, 210)
        parts = val.split("\n")
        for i, part in enumerate(parts):
            if part: cur.append((part, color, bool(st["bold"])))
            if i < len(parts) - 1: lines.append(cur); cur = []
    if cur: lines.append(cur)
    width = int(max((sum(len(t) for t, _, _ in ln) for ln in lines), default=10) * char_w) + 2*pad
    height = len(lines)*line_h + 2*pad + 44
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, width-1, height-1], radius=24, fill=(21, 23, 24, 255))
    for i, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        d.ellipse([pad//2 + i*36, 34, pad//2 + i*36 + 20, 54], fill=c)
    y = 44 + pad
    for ln in lines:
        x = pad
        for text, color, bold in ln:
            d.text((x, y), text, font=font_b if bold else font, fill=color)
            x += font.getlength(text)
        y += line_h
    buf = io.BytesIO(); img.save(buf, "PNG")
    return buf.getvalue(), img.size

# ---------- русская типографика ----------
NBSP = " "
_SHORT = ("и а но да не ни в во на о об обо от ото к ко с со у за из изо над под подо при про "
          "для по до без безо же ли бы то как что чем это мы вы он они я ты".split())
_SHORT_RE = re.compile(r"\b(" + "|".join(_SHORT) + r")[  ]+", re.IGNORECASE)
def typograf(text):
    if not text: return text
    text = _SHORT_RE.sub(lambda m: m.group(1) + NBSP, text)
    text = re.sub(r" +(—|–)", NBSP + r"\1", text)
    text = re.sub(r"(\d) +(?=[А-Яа-яЁё\d])", r"\1" + NBSP, text)
    return text

BRAND_TEXT = "080040"; BRAND_LINK = "FF067E"
def recolor_run(rpr):
    is_link = rpr.find(q("a:hlinkClick")) is not None
    for fill in rpr.findall(q("a:solidFill")): rpr.remove(fill)
    fill = etree.Element(q("a:solidFill"))
    clr = etree.SubElement(fill, q("a:srgbClr")); clr.set("val", BRAND_LINK if is_link else BRAND_TEXT)
    rpr.insert(0, fill)

def strip_small_lists(sp):
    tx = sp.find(q("p:txBody"))
    if tx is None: return
    def bulleted(p):
        ppr = p.find(q("a:pPr"))
        return ppr is not None and (ppr.find(q("a:buChar")) is not None or ppr.find(q("a:buAutoNum")) is not None)
    groups, cur = [], []
    for p in tx.findall(q("a:p")):
        if bulleted(p): cur.append(p)
        else:
            if cur: groups.append(cur); cur = []
    if cur: groups.append(cur)
    for g in groups:
        if len(g) < 4:
            for p in g:
                ppr = p.find(q("a:pPr"))
                for tag in ("a:buChar", "a:buAutoNum", "a:buClr", "a:buSzPts", "a:buFont"):
                    for el in ppr.findall(q(tag)): ppr.remove(el)
                etree.SubElement(ppr, q("a:buNone"))
                ppr.set("marL", "0"); ppr.set("indent", "0")

# ---------- пакет (zip в памяти) ----------
class Package:
    def __init__(self, data):
        self.files = data          # path -> bytes
        self.trees = {}            # path -> parsed etree (write-back on save)
    @classmethod
    def from_bytes(cls, b):
        z = zipfile.ZipFile(io.BytesIO(b))
        return cls({n: z.read(n) for n in z.namelist() if not n.endswith("/")})
    def tree(self, path):
        if path not in self.trees:
            self.trees[path] = etree.parse(io.BytesIO(self.files[path]))
        return self.trees[path]
    def to_bytes(self):
        for path, t in self.trees.items():
            self.files[path] = etree.tostring(t, xml_declaration=True, encoding="UTF-8", standalone=True)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for n, b in self.files.items(): z.writestr(n, b)
        return buf.getvalue()
    def drop(self, path):
        self.files.pop(path, None); self.trees.pop(path, None)

def rels_path(slide_path):
    d, f = posixpath.split(slide_path)
    return f"{d}/_rels/{f}.rels"

def add_rel(pkg, slide_path, rtype, target, external=False):
    root = pkg.tree(rels_path(slide_path)).getroot()
    ids = [int(r.get("Id")[3:]) for r in root if r.get("Id", "").startswith("rId")]
    rid = f"rId{max(ids) + 1 if ids else 1}"
    el = etree.SubElement(root, f"{{{RELNS}}}Relationship")
    el.set("Id", rid); el.set("Type", rtype); el.set("Target", target)
    if external: el.set("TargetMode", "External")
    return rid

_id_counter = [3000]
def new_id():
    _id_counter[0] += 1; return str(_id_counter[0])

def make_pic(rid, x, y, cx, cy):
    xml = f'''<p:pic xmlns:p="{NS['p']}" xmlns:a="{NS['a']}" xmlns:r="{NS['r']}">
<p:nvPicPr><p:cNvPr id="{new_id()}" name="codecard"/><p:cNvPicPr preferRelativeResize="0"/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'''
    return etree.fromstring(xml)

# ---------- текстовые утилиты ----------
def texts_of(sp): return "".join(t.text or "" for t in sp.iter(q("a:t")))

def find_sp(root, marker):
    for sp in root.iter(q("p:sp")):
        if marker in texts_of(sp): return sp
    return None

def set_run_text(para, text):
    runs = para.findall(q("a:r"))
    runs[0].find(q("a:t")).text = typograf(text)
    for r in runs[1:]: para.remove(r)

def set_single_text(sp, text, ext_cy=None, sz=None):
    tx = sp.find(q("p:txBody"))
    paras = tx.findall(q("a:p"))
    set_run_text(paras[0], text)
    for p in paras[1:]: tx.remove(p)
    if sz:
        for rpr in paras[0].iter(q("a:rPr")): rpr.set("sz", str(sz))
    if ext_cy:
        ext = sp.find(f"{q('p:spPr')}/{q('a:xfrm')}/{q('a:ext')}")
        if ext is not None: ext.set("cy", str(ext_cy))

def set_title(root, text):
    for sp in root.iter(q("p:sp")):
        for rpr in sp.iter(q("a:rPr")):
            lat = rpr.find(q("a:latin"))
            if rpr.get("sz") == "4000" and lat is not None and "JetBrains" in (lat.get("typeface") or ""):
                two_lines = len(text) > 22
                sz = 4000 if len(text) <= 30 else (3200 if len(text) <= 44 else 2800)
                set_single_text(sp, text, ext_cy=1169700 if two_lines else None,
                                sz=None if sz == 4000 else sz)
                return 1254300 if two_lines else 761700
    return 761700

# ---------- уровни body text + солвер ----------
TIERS = (2000, 1400, 1000)
def _tier(sz): return 2000 if sz >= 1800 else (1400 if sz >= 1050 else 1000)

def _box(el):
    for path in (f"{q('p:spPr')}/{q('a:xfrm')}", f"{q('p:grpSpPr')}/{q('a:xfrm')}", f"{q('p:xfrm')}"):
        x = el.find(path)
        if x is not None and x.find(q("a:off")) is not None and x.find(q("a:ext")) is not None:
            o, e = x.find(q("a:off")), x.find(q("a:ext"))
            return [int(o.get("x")), int(o.get("y")), int(e.get("cx")), int(e.get("cy"))]
    return None

def _fits(sp, tier):
    b = _box(sp)
    if b is None: return True
    cx, cy = b[2] - 2*91425, b[3] - 2*91425
    if cx <= 0 or cy <= 0: return True
    char_w = tier/100 * 12700 * 0.52; line_h = tier/100 * 12700 * 1.25
    lines = 0
    for p in sp.findall(f"{q('p:txBody')}/{q('a:p')}"):
        n = len("".join(t.text or "" for t in p.iter(q("a:t"))))
        lines += max(1, -(-n // max(1, int(cx/char_w))))
    return lines * line_h <= cy * 1.05

def _content_rect(sp, tier, hfudge=1.3):
    """hfudge=1.3 — консервативно (для расстановки, разводим с запасом);
    hfudge≈1.02 — реалистично (для честного флажка об остаточном наезде)."""
    b = _box(sp)
    if b is None: return None
    x, y, cx, cy = b
    char_w = tier/100 * 12700 * 0.52; line_h = tier/100 * 12700 * 1.25
    usable = max(1, cx - 91425)
    lines, maxw = 0, 0
    for p in sp.findall(f"{q('p:txBody')}/{q('a:p')}"):
        n = len("".join(t.text or "" for t in p.iter(q("a:t"))))
        ln = max(1, -(-int(n*char_w) // usable))
        lines += ln
        maxw = max(maxw, usable if ln > 1 else int(n*char_w))
    h = int(lines*line_h*hfudge) + 91425
    bp = sp.find(f"{q('p:txBody')}/{q('a:bodyPr')}")
    anchor = bp.get("anchor") if bp is not None else "t"
    ry = y + cy - h if anchor == "b" and h < cy else y
    return [x, ry, min(maxw + 91425, cx), h]

def _hit(a, b, pad=40000):
    return (a[0] < b[0]+b[2]-pad and b[0] < a[0]+a[2]-pad and
            a[1] < b[1]+b[3]-pad and b[1] < a[1]+a[3]-pad)

def _in_slide(r):
    return r[1]+r[3] <= H-20000 and r[0]+r[2] <= W-20000

MIN_PT = 900   # нижний предел кегля при подгонке (9pt)

def _cur_pt(run_tiers):
    return max(int(rpr.get("sz") or 1400) for rpr, _ in run_tiers)

def _set_pt(run_tiers, pt):
    for rpr, _ in run_tiers:
        rpr.set("sz", str(pt))

def _shrink_to_selffit(sp, run_tiers):
    """Уменьшать кегль, пока текст не влезет в СВОЙ бокс (не вылезет вниз на соседа)."""
    pt = _cur_pt(run_tiers)
    while pt > MIN_PT and not _fits(sp, pt):
        pt = max(MIN_PT, int(pt * 0.92))
        _set_pt(run_tiers, pt)

def _try_lift(sp, cands, others):
    for t in cands:
        r = _content_rect(sp, t)
        if r is None: continue
        dy = r[1] + r[3] - (H - 20000)
        if dy <= 0: continue
        r2 = [r[0], r[1]-dy, r[2], r[3]]
        if r2[1] > 700000 and not any(_hit(r2, o) for o in others):
            off = sp.find(f"{q('p:spPr')}/{q('a:xfrm')}/{q('a:off')}")
            off.set("y", str(int(off.get("y")) - dy))
            return t, r2
    return None, None

def normalize_typography(kids):
    sps = [sp for el in kids for sp in ([el] if etree.QName(el).localname == "sp" else el.iter(q("p:sp")))]
    frames = [gf for el in kids for gf in ([el] if etree.QName(el).localname == "graphicFrame" else el.iter(q("p:graphicFrame")))]
    top = {id(el) for el in kids}
    tiers_map = {}
    for sp in sps + frames:
        if etree.QName(sp).localname == "sp": strip_small_lists(sp)
        for p in sp.iter(q("a:p")):
            ppr = p.find(q("a:pPr"))
            if ppr is None:
                ppr = etree.Element(q("a:pPr")); p.insert(0, ppr)
            ln = ppr.find(q("a:lnSpc"))
            if ln is not None: ppr.remove(ln)
            ln = etree.Element(q("a:lnSpc"))
            pct = etree.SubElement(ln, q("a:spcPct")); pct.set("val", "100000")
            ppr.insert(0, ln)
        run_tiers = []
        for r in sp.iter(q("a:r")):
            rpr = r.find(q("a:rPr"))
            if rpr is None:
                rpr = etree.Element(q("a:rPr")); r.insert(0, rpr)
            sz = int(rpr.get("sz")) if rpr.get("sz") else 1400
            run_tiers.append((rpr, _tier(sz)))
            for tag in ("a:latin", "a:ea", "a:cs", "a:sym"):
                f = rpr.find(q(tag))
                if f is None: f = etree.SubElement(rpr, q(tag))
                f.set("typeface", "Inter")
            recolor_run(rpr)
            t_el = r.find(q("a:t"))
            if t_el is not None and t_el.text: t_el.text = typograf(t_el.text)
        if not run_tiers: continue
        if id(sp) in top and etree.QName(sp).localname == "sp":
            tiers_map[sp] = run_tiers
        else:
            if etree.QName(sp).localname == "sp":
                dom = max(t for _, t in run_tiers)
                while dom > TIERS[-1] and not _fits(sp, dom):
                    dom = TIERS[min(TIERS.index(dom)+1, len(TIERS)-1)]
                    run_tiers = [(rpr, TIERS[min(TIERS.index(t)+1, len(TIERS)-1)]) for rpr, t in run_tiers]
            for rpr, t in run_tiers: rpr.set("sz", str(t))
        for epr in sp.iter(q("a:endParaRPr")):
            if epr.get("sz"): epr.set("sz", str(_tier(int(epr.get("sz")))))
        if etree.QName(sp).localname == "sp":
            txt = texts_of(sp).strip()
            if 0 < len(txt) <= 14:
                bp = sp.find(f"{q('p:txBody')}/{q('a:bodyPr')}")
                if bp is not None: bp.set("wrap", "none")
                xf = sp.find(f"{q('p:spPr')}/{q('a:xfrm')}")
                if xf is not None and xf.find(q("a:ext")) is not None:
                    t_max = max(t for _, t in run_tiers)
                    need = int(len(txt) * t_max/100 * 12700 * 0.85 + 200000)
                    ext = xf.find(q("a:ext"))
                    if int(ext.get("cx")) < need: ext.set("cx", str(need))
                tiers_map.pop(sp, None)
                for rpr, t in run_tiers: rpr.set("sz", str(t))
    return tiers_map

def align_body_blocks(kids):
    for el in kids:
        if etree.QName(el).localname != "sp": continue
        if not texts_of(el).strip(): continue
        xf = el.find(f"{q('p:spPr')}/{q('a:xfrm')}")
        if xf is None: continue
        off, ext = xf.find(q("a:off")), xf.find(q("a:ext"))
        if off is None or ext is None: continue
        x, cx = int(off.get("x")), int(ext.get("cx"))
        if x < 0.18*W and cx > 0.38*W:
            off.set("x", str(TITLE_X))
            ext.set("cx", str(cx + (x - TITLE_X)))

def layout_solver(kids, tiers_map):
    """Возвращает список нерешённых коллизий (для замечаний)."""
    unresolved = []
    obstacles = []
    for el in kids:
        ln = etree.QName(el).localname
        if ln == "cxnSp": continue
        if ln == "sp":
            if el in tiers_map: continue
            geom = el.find(f"{q('p:spPr')}/{q('a:prstGeom')}")
            if geom is not None and "onnector" in (geom.get("prst") or ""): continue
            if not texts_of(el).strip():
                b = _box(el)
                if b is None or min(b[2], b[3]) < 250000: continue
        b = _box(el)
        if b:
            names = " ".join(c.get("name", "") for c in el.iter(q("p:cNvPr")))
            obstacles.append((b, "codecard" in names))
    texts = sorted(tiers_map.keys(), key=lambda s: (_box(s) or [0, 0])[1])
    placed = []          # (sp, run_tiers) — для финального де-оверлапа
    placed_rects = []    # выбранные прямоугольники — чтобы следующие блоки их избегали
    for sp in texts:
        run_tiers = tiers_map[sp]
        dom = max(t for _, t in run_tiers)
        best = TIERS[max(0, TIERS.index(dom)-1)] if dom == 1000 else dom
        cands = [t for t in TIERS if t <= best]
        bx = _box(sp)
        others = [o for o, solid in obstacles if solid or bx is None or not _hit(bx, o, 0)]
        others += placed_rects
        chosen, rect = None, None
        for t in cands:
            r = _content_rect(sp, t)
            if r and _in_slide(r) and _fits(sp, t) and not any(_hit(r, o) for o in others):
                chosen, rect = t, r; break
        if chosen is None:
            b = _box(sp)
            if b:
                right = [o for o in others if o[0] > b[0] + 0.3*b[2] and _hit(b, o, 0)]
                if right:
                    new_cx = min(o[0] for o in right) - b[0] - 91425
                    if new_cx > max(900000, 0.4*b[2]):
                        ext_el = sp.find(f"{q('p:spPr')}/{q('a:xfrm')}/{q('a:ext')}")
                        ext_el.set("cx", str(new_cx))
                        for t in cands:
                            r = _content_rect(sp, t)
                            if r and _in_slide(r) and not any(_hit(r, o) for o in others):
                                chosen, rect = t, r; break
                        if chosen is None:
                            ext_el.set("cx", str(b[2]))
                if chosen is None:
                    left = [o for o in others if o[0]+o[2] < b[0]+0.7*b[2] and _hit(b, o, 0)]
                    if left:
                        new_x = max(o[0]+o[2] for o in left) + 91425
                        new_cx = b[0] + b[2] - new_x
                        if new_cx > max(900000, 0.4*b[2]):
                            xf = sp.find(f"{q('p:spPr')}/{q('a:xfrm')}")
                            xf.find(q("a:off")).set("x", str(new_x))
                            xf.find(q("a:ext")).set("cx", str(new_cx))
                            for t in cands:
                                r = _content_rect(sp, t)
                                if r and _in_slide(r) and not any(_hit(r, o) for o in others):
                                    chosen, rect = t, r; break
                            if chosen is None:
                                chosen, rect = _try_lift(sp, cands, others)
                            if chosen is None:
                                xf.find(q("a:off")).set("x", str(b[0]))
                                xf.find(q("a:ext")).set("cx", str(b[2]))
        if chosen is None:
            chosen, rect = _try_lift(sp, cands, others)
        if chosen is None:
            chosen = TIERS[-1]; rect = _content_rect(sp, chosen)
            # не флажим здесь: финальный де-оверлап ниже — единственный судья наездов
        steps = TIERS.index(chosen) - TIERS.index(dom)
        for rpr, t in run_tiers:
            nt = TIERS[min(max(TIERS.index(t) + steps, 0), len(TIERS)-1)]
            rpr.set("sz", str(nt))
        _shrink_to_selffit(sp, run_tiers)     # G1: текст не вылезает из своего бокса
        placed.append((sp, run_tiers))
        if rect:
            placed_rects.append(rect)

    # G2: устраняем ПЕРЕСЕЧЕНИЯ ТЕКСТ-НА-ТЕКСТ и текст-на-картинку.
    # Итеративно до неподвижной точки: если два текста накладываются — ужимаем верхний
    # (обычно его текст растёт вниз), при упоре в пол — нижний, затем сдвиг нижнего вниз.
    solids = [b for b, solid in obstacles]     # картинки/таблицы/код-карточки — не двигаем
    def rect_now(sp, rt):
        return _content_rect(sp, _cur_pt(rt))
    for _ in range(12):
        changed = False
        order = sorted(placed, key=lambda it: (rect_now(*it) or [0, 0])[1])
        rects = {id(it[0]): rect_now(*it) for it in order}
        for a in range(len(order)):
            spa, rta = order[a]; ra = rects[id(spa)]
            if ra is None:
                continue
            # конфликты: другие текстовые блоки + сплошные объекты
            confs = []
            for b in range(len(order)):
                if b == a:
                    continue
                rb = rects[id(order[b][0])]
                if rb and _hit(ra, rb, pad=20000):
                    confs.append(("text", order[b]))
            for ob in solids:
                if _hit(ra, ob, pad=20000):
                    confs.append(("solid", ob))
            if not confs:
                continue
            # 1) ужать верхний блок пары (spa), пока не разъедется, до пола
            pt = _cur_pt(rta)
            while pt > MIN_PT:
                pt = max(MIN_PT, int(pt * 0.9))
                _set_pt(rta, pt)
                ra = rect_now(spa, rta); rects[id(spa)] = ra
                if ra is None:
                    break
                still = any(rects[id(o[0])] and _hit(ra, rects[id(o[0])], 20000)
                            for k, o in confs if k == "text") or \
                        any(_hit(ra, ob, 20000) for k, ob in confs if k == "solid")
                changed = True
                if not still:
                    break
            # 2) если всё ещё пересекается с текстом-соседом снизу — сдвинуть соседа вниз
            ra = rects[id(spa)]
            if ra:
                for k, o in confs:
                    if k != "text":
                        continue
                    spb, rtb = o; rb = rects[id(spb)]
                    if not (rb and _hit(ra, rb, 20000)):
                        continue
                    bb = _box(spb)
                    if bb is None:
                        continue
                    dy = (ra[1] + ra[3]) - rb[1] + 40000
                    if dy > 0 and bb[1] + dy + rb[3] <= H - 20000:
                        off = spb.find(f"{q('p:spPr')}/{q('a:xfrm')}/{q('a:off')}")
                        off.set("y", str(bb[1] + dy))
                        rects[id(spb)] = rect_now(spb, rtb)
                        changed = True
        if not changed:
            break

    # что осталось пересекающимся после всех попыток — во «нерешённое» (для замечаний).
    # Здесь оценка РЕАЛИСТИЧНАЯ (hfudge≈1.02), чтобы не пугать фантомными микронаездами.
    final = {id(it[0]): _content_rect(it[0], _cur_pt(it[1]), hfudge=1.02) for it in placed}
    seen = set()
    for i, (spa, rta) in enumerate(placed):
        ra = final[id(spa)]
        if ra is None:
            continue
        for j, (spb, rtb) in enumerate(placed):
            if j <= i:
                continue
            rb = final[id(spb)]
            # флажок только при ЗАМЕТНОМ остаточном наезде (оценка высоты консервативна,
            # поэтому микропересечения по оценке — не повод пугать пользователя)
            if rb and _hit(ra, rb, pad=130000):
                for s in (spa, spb):
                    t = texts_of(s).strip()[:40]
                    if t and t not in seen:
                        seen.add(t); unresolved.append(t)
    return unresolved

# ---------- код в тексте ----------
_CODE_PAT = re.compile(r"\b(def|import|class|return|for|while|print|if|else|lambda)\b"
                       r"|[=(){}\[\];]|->|==")
def looks_like_code(paras_text):
    if len(paras_text) < 2: return False
    joined = "\n".join(paras_text)
    if "http" in joined: return False
    cyr = len(re.findall(r"[А-Яа-яЁё]", joined))
    return len(_CODE_PAT.findall(joined)) >= 6 and cyr < len(joined) * 0.1

# ---------- конвертация ----------
def _slide_order(pkg):
    pres = pkg.tree("ppt/presentation.xml").getroot()
    rels = {r.get("Id"): r.get("Target") for r in pkg.tree("ppt/_rels/presentation.xml.rels").getroot()}
    out = []
    for sid in pres.iter(q("p:sldId")):
        t = rels[sid.get(q("r:id"))]
        out.append(posixpath.normpath(posixpath.join("ppt", t)))
    return out

def _slide_info(pkg, path):
    root = pkg.tree(path).getroot()
    info = {"path": path, "title": None, "title_sp": None, "texts": [], "npics": 0, "ntables": 0, "nshapes": 0}
    spTree = root.find(f"{q('p:cSld')}/{q('p:spTree')}")
    for el in spTree:
        ln = etree.QName(el).localname
        if ln in ("nvGrpSpPr", "grpSpPr"): continue
        info["nshapes"] += 1
        if ln == "graphicFrame": info["ntables"] += 1
        info["npics"] += len(list(el.iter(q("p:pic"))))
        if ln == "sp":
            ph = el.find(f".//{q('p:ph')}")
            txt = texts_of(el).strip()
            if ph is not None and ph.get("type") in ("title", "ctrTitle"):
                info["title"] = txt; info["title_sp"] = el
            elif txt:
                info["texts"].append(txt)
    if info["title"] is None:
        # fallback: самый крупный короткий текст наверху
        best = None
        for el in spTree.iter(q("p:sp")):
            txt = texts_of(el).strip()
            b = _box(el)
            if not txt or len(txt) > 80 or b is None or b[1] > 0.25*H: continue
            szs = [int(r.get("sz")) for r in el.iter(q("a:rPr")) if r.get("sz")]
            key = max(szs) if szs else 0
            if best is None or key > best[0]: best = (key, txt, el)
        if best:
            info["title"], info["title_sp"] = best[1], best[2]
    return info

def _dup_slide(tpl, donor_n, new_n):
    src, dst = f"ppt/slides/slide{donor_n}.xml", f"ppt/slides/slide{new_n}.xml"
    tpl.files[dst] = tpl.files[src]
    rels = etree.parse(io.BytesIO(tpl.files[rels_path(src)]))
    for rel in list(rels.getroot()):
        if "notesSlide" in rel.get("Type", ""): rels.getroot().remove(rel)
    tpl.files[rels_path(dst)] = etree.tostring(rels, xml_declaration=True, encoding="UTF-8", standalone=True)
    ct = tpl.tree("[Content_Types].xml").getroot()
    o = etree.SubElement(ct, f"{{{CTNS}}}Override")
    o.set("PartName", f"/{dst}"); o.set("ContentType", SLIDE_CT)
    rid = add_rel(tpl, "ppt/presentation.xml", SLIDE_T, f"slides/slide{new_n}.xml")
    return dst, rid

def transplant(tpl, dst_path, src, src_path, title_bottom, remarks, out_no):
    droot = tpl.tree(dst_path).getroot()
    sroot = src.tree(src_path).getroot()
    srels = {r.get("Id"): (r.get("Type"), r.get("Target"), r.get("TargetMode"))
             for r in src.tree(rels_path(src_path)).getroot()} if rels_path(src_path) in src.files else {}
    kids = []
    sinfo_title = _slide_info(src, src_path)["title_sp"]
    for el in sroot.find(f"{q('p:cSld')}/{q('p:spTree')}"):
        ln = etree.QName(el).localname
        if ln in ("nvGrpSpPr", "grpSpPr"): continue
        ph = el.find(f".//{q('p:ph')}")
        if ph is not None and ph.get("type") in ("title", "ctrTitle"): continue
        if sinfo_title is not None and el is sinfo_title: continue
        kids.append(copy.deepcopy(el))
    for el in kids:
        for ph in el.findall(f".//{q('p:ph')}"): ph.getparent().remove(ph)
        for cnv in el.iter(q("p:cNvPr")): cnv.set("id", new_id())
    # перенос медиа и ссылок
    for el in kids:
        for attr in (q("r:embed"), q("r:link")):
            for node in el.iter():
                rid_src = node.get(attr)
                if not rid_src or rid_src not in srels: continue
                rtype, target, mode = srels[rid_src]
                if mode == "External":
                    rid = add_rel(tpl, dst_path, rtype, target, external=True)
                else:
                    spath = posixpath.normpath(posixpath.join("ppt/slides", target))
                    dname = "u_" + posixpath.basename(spath)
                    tpl.files[f"ppt/media/{dname}"] = src.files[spath]
                    _ensure_ct_default(tpl, dname.rsplit(".", 1)[-1])
                    rid = add_rel(tpl, dst_path, IMG_T, f"../media/{dname}")
                node.set(attr, rid)
        for node in el.iter(q("a:hlinkClick")):
            rid_src = node.get(q("r:id"))
            if rid_src and rid_src in srels:
                _, target, _ = srels[rid_src]
                node.set(q("r:id"), add_rel(tpl, dst_path, LNK_T, target, external=True))
    # код, набранный текстом -> карточка
    if HAS_CARDS:
        for i, el in enumerate(kids):
            if etree.QName(el).localname != "sp": continue
            paras = [ "".join(t.text or "" for t in p.iter(q("a:t")))
                      for p in el.findall(f"{q('p:txBody')}/{q('a:p')}") ]
            paras = [p for p in paras if p.strip()]
            if not looks_like_code(paras): continue
            b = _box(el)
            if b is None: continue
            png, (iw, ih) = render_code_card("\n".join(paras))
            name = f"codecard_{out_no}_{i}.png"
            tpl.files[f"ppt/media/{name}"] = png
            _ensure_ct_default(tpl, "png")
            rid = add_rel(tpl, dst_path, IMG_T, f"../media/{name}")
            k = min(b[2]/iw, b[3]/ih)
            w2, h2 = int(iw*k), int(ih*k)
            kids[i] = make_pic(rid, b[0] + (b[2]-w2)//2, b[1] + (b[3]-h2)//2, w2, h2)
            remarks.append({"slide": out_no, "action": "код оформлен карточкой",
                            "comment": "проверьте подсветку и переносы"})
    # сдвиг/масштаб при конфликте с заголовком
    def get_xfrm(el):
        for path in (f"{q('p:spPr')}/{q('a:xfrm')}", f"{q('p:grpSpPr')}/{q('a:xfrm')}", f"{q('p:xfrm')}"):
            x = el.find(path)
            if x is not None: return x
        return None
    ys = [int(x.find(q("a:off")).get("y")) for el in kids
          if (x := get_xfrm(el)) is not None and x.find(q("a:off")) is not None]
    if ys:
        min_y = min(ys); req = title_bottom + 80000
        if min_y < req:
            f = (H - req - 140000) / (H - min_y)
            for el in kids:
                x = get_xfrm(el)
                if x is None: continue
                off, ext = x.find(q("a:off")), x.find(q("a:ext"))
                ox, oy = int(off.get("x")), int(off.get("y"))
                off.set("y", str(int(req + (oy - min_y)*f)))
                off.set("x", str(int(ox*f + W*(1-f)/2)))
                if ext is not None:
                    ext.set("cx", str(int(int(ext.get("cx"))*f)))
                    ext.set("cy", str(int(int(ext.get("cy"))*f)))
    tiers_map = normalize_typography(kids)
    align_body_blocks(kids)
    unresolved = layout_solver(kids, tiers_map)
    if unresolved:
        remarks.append({"slide": out_no, "action": "возможен наезд текста",
                        "comment": "блок «%s…» — проверьте" % unresolved[0][:30]})
    spTree = droot.find(f"{q('p:cSld')}/{q('p:spTree')}")
    for el in kids: spTree.append(el)
    return len(kids)

def _ensure_ct_default(tpl, ext):
    ct = tpl.tree("[Content_Types].xml").getroot()
    for d in ct.findall(f"{{{CTNS}}}Default"):
        if d.get("Extension") == ext: return
    d = etree.SubElement(ct, f"{{{CTNS}}}Default")
    d.set("Extension", ext)
    d.set("ContentType", {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg",
                          "gif": "image/gif"}.get(ext, "application/octet-stream"))

def _merge_table_styles(tpl, src):
    if "ppt/tableStyles.xml" not in src.files: return
    A = NS["a"]
    sroot = src.tree("ppt/tableStyles.xml").getroot()
    droot = tpl.tree("ppt/tableStyles.xml").getroot()
    have = {s.get("styleId") for s in droot.findall(f"{{{A}}}tblStyle")}
    for s in sroot.findall(f"{{{A}}}tblStyle"):
        if s.get("styleId") not in have: droot.append(copy.deepcopy(s))

# ---------- приближённые превью слайдов (SVG) ----------
# Настоящего растеризатора PPTX в браузере нет, поэтому превью — эскиз из геометрии:
# встроенные картинки переносятся точь-в-точь, текст — с переносом по словам и обрезкой.
def _svg_esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def _thumb_datauri(pkg, media_path, cache):
    if cache is not None and media_path in cache:
        return cache[media_path]
    uri = None
    try:
        im = Image.open(io.BytesIO(pkg.files[media_path])).convert("RGB")
        im.thumbnail((320, 320))
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=58)
        uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        uri = None
    if cache is not None:
        cache[media_path] = uri
    return uri

def slide_svg(pkg, slide_path, bg="F2FAFF", thumb_w=360, media_cache=None):
    """Вернуть SVG-эскиз слайда (строка) шириной thumb_w px, viewBox в EMU."""
    if slide_path not in pkg.files:
        return None
    # ВАЖНО: читаем из живого дерева (движок правит pkg.trees, а pkg.files
    # обновляются только в to_bytes()) — иначе увидим незаполненный донор.
    root = pkg.tree(slide_path).getroot()
    d = posixpath.dirname(slide_path)
    rp = rels_path(slide_path)
    rels = {}
    if rp in pkg.files:
        for r in pkg.tree(rp).getroot():
            if r.get("TargetMode") != "External":
                rels[r.get("Id")] = posixpath.normpath(posixpath.join(d, r.get("Target")))
    hh = int(H * thumb_w / W)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{thumb_w}" height="{hh}" '
           f'viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="#{bg}"/>']
    spTree = root.find(f"{q('p:cSld')}/{q('p:spTree')}")
    if spTree is None:
        out.append("</svg>"); return "".join(out)
    for el in spTree:
        tag = etree.QName(el).localname
        if tag == "pic":
            blip = el.find(f".//{q('a:blip')}")
            rid = blip.get(q("r:embed")) if blip is not None else None
            b = _box(el)
            if rid and rid in rels and b:
                uri = _thumb_datauri(pkg, rels[rid], media_cache)
                if uri:
                    out.append(f'<image x="{b[0]}" y="{b[1]}" width="{b[2]}" height="{b[3]}" '
                               f'href="{uri}" preserveAspectRatio="none"/>')
        elif tag == "graphicFrame":
            b = _box(el)
            if b:
                out.append(f'<rect x="{b[0]}" y="{b[1]}" width="{b[2]}" height="{b[3]}" '
                           f'fill="#ffffff" stroke="#c9d4e8" stroke-width="6000"/>')
        elif tag == "sp":
            b = _box(el)
            txt_paras = ["".join(t.text or "" for t in p.iter(q("a:t")))
                         for p in el.findall(f"{q('p:txBody')}/{q('a:p')}")]
            txt_paras = [p for p in txt_paras if p.strip()]
            if not b or not txt_paras:
                continue
            szs = [int(r.get("sz")) for r in el.iter(q("a:rPr")) if r.get("sz")]
            fs = (max(szs) if szs else 1400) * 127          # EMU
            clr_el = el.find(f".//{q('a:rPr')}/{q('a:solidFill')}/{q('a:srgbClr')}")
            color = "#" + (clr_el.get("val") if clr_el is not None else "222222")
            bold = el.find(f".//{q('a:rPr')}[@b='1']") is not None
            x, y, cx, cy = b
            pad = 40000
            per_line = max(4, int((cx - 2*pad) / (fs * 0.58)))
            line_h = int(fs * 1.32)
            max_lines = max(1, int((cy) / line_h))
            lines = []
            for para in txt_paras:
                words = para.split()
                cur = ""
                for w in words:
                    if len(cur) + len(w) + 1 <= per_line:
                        cur = (cur + " " + w).strip()
                    else:
                        if cur: lines.append(cur)
                        cur = w
                        if len(w) > per_line:            # длинное слово — режем
                            while len(cur) > per_line:
                                lines.append(cur[:per_line]); cur = cur[per_line:]
                if cur: lines.append(cur)
                if len(lines) >= max_lines: break
            lines = lines[:max_lines]
            if lines:
                tx = x + pad; ty = y + fs
                weight = ' font-weight="700"' if bold else ""
                spans = "".join(
                    f'<tspan x="{tx}" dy="{0 if i==0 else line_h}">{_svg_esc(ln)}</tspan>'
                    for i, ln in enumerate(lines))
                out.append(f'<text x="{tx}" y="{ty}" font-family="monospace" '
                           f'font-size="{fs}" fill="{color}"{weight}>{spans}</text>')
    out.append("</svg>")
    return "".join(out)


def convert(template_bytes, src_bytes, subtitle="WB Техношкола"):
    tpl = Package.from_bytes(template_bytes)
    src = Package.from_bytes(src_bytes)
    remarks = []
    order = _slide_order(src)
    infos = [_slide_info(src, p) for p in order]

    # план: [(donor, kind, src_info|None)]
    plan = []
    i0 = 0
    first = infos[0] if infos else None
    if first and first["npics"] == 0 and first["ntables"] == 0 and first["nshapes"] <= 3:
        plan.append((DONOR_TITLE, "title", first)); i0 = 1
    else:
        remarks.append({"slide": 1, "action": "титул не распознан",
                        "comment": "первый слайд перенесён как контентный"})
    has_q = has_t = False
    for inf in infos[i0:]:
        t = (inf["title"] or "").lower()
        body = " ".join(inf["texts"])
        if re.fullmatch(r"вопросы?[?!. ]*", t) and len(body) < 40 and inf["npics"] == 0:
            plan.append((DONOR_QUESTIONS, "questions", None)); has_q = True
        elif "спасибо" in t and len(body) < 40:
            plan.append((DONOR_THANKS, "thanks", None)); has_t = True
        else:
            plan.append((DONOR_CANVAS, "canvas", inf))
    if not has_q:
        plan.append((DONOR_QUESTIONS, "questions", None))
        remarks.append({"slide": len(plan) + (1 if i0 else 0), "action": "добавлен слайд «Вопросы»", "comment": ""})
    if not has_t:
        plan.append((DONOR_THANKS, "thanks", None))
        remarks.append({"slide": len(plan) + (1 if i0 else 0), "action": "добавлен слайд «Спасибо»", "comment": ""})

    # каркас
    existing = [int(m.group(1)) for f in tpl.files
                if (m := re.match(r"ppt/slides/slide(\d+)\.xml$", f))]
    next_n = max(existing) + 1
    made = []
    for donor, kind, inf in plan:
        dst, rid = _dup_slide(tpl, donor, next_n)
        made.append((dst, rid, kind, inf)); next_n += 1
    pres = tpl.tree("ppt/presentation.xml").getroot()
    lst = pres.find(q("p:sldIdLst"))
    for el in list(lst): lst.remove(el)
    for i, (_, rid, _, _) in enumerate(made):
        el = etree.SubElement(lst, q("p:sldId"))
        el.set("id", str(400 + i)); el.set(q("r:id"), rid)
    # выпилить исходные слайды шаблона
    prels = tpl.tree("ppt/_rels/presentation.xml.rels").getroot()
    keep_rids = {rid for _, rid, _, _ in made}
    for rel in list(prels):
        if rel.get("Type") == SLIDE_T and rel.get("Id") not in keep_rids:
            prels.remove(rel)
    ct = tpl.tree("[Content_Types].xml").getroot()
    keep_parts = {f"/{dst}" for dst, _, _, _ in made}
    for o in list(ct.findall(f"{{{CTNS}}}Override")):
        pn = o.get("PartName", "")
        if (pn.startswith("/ppt/slides/") or pn.startswith("/ppt/notesSlides/")) and pn not in keep_parts:
            ct.remove(o)
    for n in existing:
        tpl.drop(f"ppt/slides/slide{n}.xml"); tpl.drop(f"ppt/slides/_rels/slide{n}.xml.rels")
    for f in [f for f in tpl.files if f.startswith("ppt/notesSlides/")]:
        tpl.drop(f)

    # заполнение
    for out_no, (dst, rid, kind, inf) in enumerate(made, 1):
        root = tpl.tree(dst).getroot()
        if kind == "title":
            sp = find_sp(root, "Это слайд с названием")
            if sp is not None: set_single_text(sp, inf["title"] or "Название лекции")
            sp = find_sp(root, "Тут имя лектора")
            if sp is not None: set_single_text(sp, (inf["texts"][0] if inf["texts"] else subtitle))
            sp = find_sp(root, "24")
            if sp is not None: set_single_text(sp, "01")
            remarks.append({"slide": out_no, "action": "титул из шаблона",
                            "comment": "номер лекции — заглушка «01», поправьте"})
        elif kind == "canvas":
            title = inf["title"]
            if title:
                tb = set_title(root, title)
            else:
                tb = 761700
                remarks.append({"slide": out_no, "action": "заголовок не распознан",
                                "comment": "добавьте вручную"})
                sp = find_sp(root, "Теория")
                if sp is not None: sp.getparent().remove(sp)
            body = find_sp(root, "Концентрированная")
            if body is not None: body.getparent().remove(body)
            n_shapes = transplant(tpl, dst, src, inf["path"], tb, remarks, out_no)
            if n_shapes >= 9:
                remarks.append({"slide": out_no, "action": "сложная композиция",
                                "comment": "рестайл рамки, содержимое как есть — проверьте"})
    _merge_table_styles(tpl, src)

    # Превью до/после — только для слайдов с замечаниями (быстро, малый payload).
    # before — исходный слайд преподавателя, after — наш пересобранный.
    slidemap = {out_no: (inf, dst) for out_no, (dst, rid, kind, inf) in enumerate(made, 1)}
    media_cache = {}
    thumb_cache = {}    # out_no -> (before, after)
    for r in remarks:
        n = r.get("slide")
        if n not in slidemap:
            continue
        if n not in thumb_cache:
            inf, dst = slidemap[n]
            before = slide_svg(src, inf["path"], bg="FFFFFF", media_cache=media_cache) if inf else None
            after = slide_svg(tpl, dst, bg="F2FAFF", media_cache=media_cache)
            thumb_cache[n] = (before, after)
        before, after = thumb_cache[n]
        if before:
            r["before"] = before
        if after:
            r["after"] = after
    return tpl.to_bytes(), remarks

if __name__ == "__main__":
    import sys, json
    tpl = open(sys.argv[1], "rb").read()
    srcb = open(sys.argv[2], "rb").read()
    out, remarks = convert(tpl, srcb)
    open(sys.argv[3], "wb").write(out)
    print(json.dumps(remarks, ensure_ascii=False, indent=1))
