"""局部调整算法：画笔蒙版 + 区域色彩调整。

支持的需求：
- 涂抹一块区域（paint），也支持橡皮（erase），可多次涂抹叠加；
- 每「处」调整是一个独立图层，蒙版内可包含多条笔触；
- 画笔大小（size，归一化到图像宽度的比例，与分辨率无关）、
  羽化边缘（feather，0~1，软边 cosine 衰减 + 高斯羽化）、
  流量（flow，单次涂抹的不透明度）；
- 调整项：亮度、对比度、饱和度、色温、色调；图层整体强度 strength（0~1）
  作为调整的总不透明度，可随时改小而不丢失涂抹；
- 蒙版边缘通过软边印戳 + 高斯模糊自然过渡，不出现生硬色块边界。

文档（document）结构（JSON 可序列化，分辨率无关）：

    {"layers": [
        {"id": "...", "name": "提亮", "visible": true, "strength": 1.0,
         "params": {"brightness": 30, "contrast": 0, "saturation": 0,
                    "temperature": 0, "tint": 0},
         "strokes": [
            {"type": "paint"|"erase", "size": 0.08, "feather": 0.35,
             "flow": 0.6, "points": [[0.1, 0.2], [0.12, 0.22], ...]}
         ]}
    ]}

点坐标 x/y 均为相对图像宽/高的 0~1 归一化值。
"""
import math

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

from . import util

# ---------------------------------------------------------------------------
# 限制（防止前端传入超大文档拖垮服务）
# ---------------------------------------------------------------------------
MAX_LAYERS = 30
MAX_STROKES_PER_LAYER = 400
MAX_POINTS_PER_STROKE = 6000

ADJUST_KEYS = ("brightness", "contrast", "saturation", "temperature", "tint")
ADJUST_RANGE = 100.0


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _num(v, default, lo=None, hi=None):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


# ---------------------------------------------------------------------------
# 文档规范化（服务端兜底校验，非法值直接回退默认，不报错打断预览）
# ---------------------------------------------------------------------------
def normalize_document(doc):
    """把前端文档清洗为安全、完整的结构。"""
    if not isinstance(doc, dict):
        doc = {}
    out_layers = []
    for i, layer in enumerate(doc.get("layers", [])[:MAX_LAYERS]):
        if not isinstance(layer, dict):
            continue
        p = layer.get("params") if isinstance(layer.get("params"), dict) else {}
        params = {k: clamp(_num(p.get(k), 0.0, -ADJUST_RANGE, ADJUST_RANGE), -ADJUST_RANGE, ADJUST_RANGE)
                  for k in ADJUST_KEYS}
        strokes = []
        for st in layer.get("strokes", [])[:MAX_STROKES_PER_LAYER]:
            if not isinstance(st, dict):
                continue
            pts = []
            raw_pts = st.get("points", [])
            if isinstance(raw_pts, list):
                for q in raw_pts[:MAX_POINTS_PER_STROKE]:
                    if isinstance(q, (list, tuple)) and len(q) >= 2:
                        pts.append([clamp(_num(q[0], 0.0, 0.0, 1.0), 0.0, 1.0),
                                    clamp(_num(q[1], 0.0, 0.0, 1.0), 0.0, 1.0)])
            if not pts:
                continue
            strokes.append({
                "type": "erase" if st.get("type") == "erase" else "paint",
                # size 相对图像宽度，允许到 0.8；feather/flow 在 0~1
                "size": _num(st.get("size"), 0.08, 0.001, 0.8),
                "feather": _num(st.get("feather"), 0.35, 0.0, 1.0),
                "flow": _num(st.get("flow"), 0.6, 0.02, 1.0),
                "points": pts,
            })
        out_layers.append({
            "id": str(layer.get("id") or f"l{i}"),
            "name": str(layer.get("name") or f"调整 {i + 1}")[:40],
            "visible": bool(layer.get("visible", True)),
            "strength": _num(layer.get("strength"), 1.0, 0.0, 1.0),
            "params": params,
            "strokes": strokes,
        })
    return {"layers": out_layers}


# ---------------------------------------------------------------------------
# 蒙版栅格化
# ---------------------------------------------------------------------------
_dab_cache = {}
_DAB_CACHE_MAX = 96


def _soft_dab(radius, feather):
    """生成一张边长 2r 的软边圆形印戳（L 模式，白底黑外），带缓存。

    轮廓：实心区域线性衰减到 0（cosine 半周期），feather 决定软边带宽占比；
    feather=0 时几乎是硬边圆（仍保留 1px 抗锯齿），feather=1 时从圆心开始衰减。
    """
    r = max(1.0, float(radius))
    ri = max(2, int(round(r)))
    key = (ri, round(clamp(feather, 0.0, 1.0), 3))
    cached = _dab_cache.get(key)
    if cached is not None:
        return cached

    f = clamp(feather, 0.0, 1.0)
    sigma = 0.45 + f * f * (r * 0.9)  # 软边宽度随半径与羽化比例增长
    # 画布必须比圆大出模糊半径，否则高斯光晕在印戳边缘被裁断形成硬环
    pad = int(math.ceil(sigma * 3.0)) + 1
    size = (ri + pad) * 2
    # 硬内圆
    base = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(base)
    box = [pad, pad, pad + 2 * ri - 1, pad + 2 * ri - 1]
    draw.ellipse(box, fill=255)
    soft = base.filter(ImageFilter.GaussianBlur(sigma))

    if len(_dab_cache) >= _DAB_CACHE_MAX:
        _dab_cache.clear()
    _dab_cache[key] = soft
    return soft


def _interpolated(points, step):
    """沿折线按间距 step（像素）插值，快速拖动也不留间隙。"""
    out = [points[0]]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        dx, dy = x1 - x0, y1 - y0
        dist = math.hypot(dx, dy)
        n = max(1, int(math.ceil(dist / max(step, 1e-6))))
        for k in range(1, n + 1):
            t = k / n
            out.append((x0 + dx * t, y0 + dy * t))
    return out


def rasterize_stroke(stroke, size):
    """把一条笔触栅格化为 L 蒙版（0~255）。size=(w,h) 像素。"""
    w, h = size
    sx, sy = float(w), float(h)
    radius = stroke["size"] * sx
    dab0 = _soft_dab(radius, stroke["feather"])
    dsize = dab0.size[0]
    alpha = clamp(stroke["flow"], 0.0, 1.0)
    dab = dab0.point(lambda v: int(v * alpha)) if alpha < 0.999 else dab0

    layer = Image.new("L", (w, h), 0)
    pts = [(p[0] * sx, p[1] * sy) for p in stroke["points"]]
    spacing = max(1.0, radius * 0.18)
    half = dsize / 2.0
    for x, y in _interpolated(pts, spacing):
        # 印戳只按自身包围盒建小画布并裁剪到画面内，避免每戳分配整图大小
        cx, cy = int(round(x - half)), int(round(y - half))
        sx0, sy0 = max(0, cx), max(0, cy)
        sx1, sy1 = min(w, cx + dsize), min(h, cy + dsize)
        if sx0 >= sx1 or sy0 >= sy1:
            continue
        stamp = dab.crop((sx0 - cx, sy0 - cy, sx1 - cx, sy1 - cy))
        # 同一笔触内部取较亮：重叠处不累加出硬团块，整条轨迹均匀
        region = layer.crop((sx0, sy0, sx1, sy1))
        region = ImageChops.lighter(region, stamp)
        layer.paste(region, (sx0, sy0))
    return layer


def rasterize_layer(layer, size):
    """合并图层内所有笔触为一张蒙版；paint 叠加，erase 扣减。"""
    w, h = size
    mask = Image.new("L", (w, h), 0)
    for stroke in layer["strokes"]:
        sm = rasterize_stroke(stroke, size)
        if stroke["type"] == "erase":
            mask = ImageChops.subtract(mask, sm)
        else:
            # 不同笔触之间做「累加但封顶」：允许反复涂抹加深，上限 255
            mask = ImageChops.add(mask, sm, scale=1.0, offset=0)
    return mask


# ---------------------------------------------------------------------------
# 区域调整
# ---------------------------------------------------------------------------
def _temperature(image, amount):
    """色温：正值偏暖（升红降蓝），负值偏冷。amount ∈ [-100, 100]。"""
    a = amount / 100.0
    if abs(a) < 1e-6:
        return image
    r, g, b = image.split()
    r_g = 1.0 + 0.28 * a
    g_g = 1.0 - 0.04 * abs(a)
    b_g = 1.0 - 0.28 * a
    r = r.point(lambda v: util.clamp(v * r_g))
    g = g.point(lambda v: util.clamp(v * g_g))
    b = b.point(lambda v: util.clamp(v * b_g))
    return Image.merge("RGB", (r, g, b))


def _tint(image, amount):
    """色调（绿/品红）微调：amount ∈ [-100, 100]，正绿负品红。"""
    a = amount / 100.0
    if abs(a) < 1e-6:
        return image
    r, g, b = image.split()
    g_g = 1.0 + 0.22 * a
    r_g = 1.0 - 0.11 * a
    b_g = 1.0 - 0.11 * a
    r = r.point(lambda v: util.clamp(v * r_g))
    g = g.point(lambda v: util.clamp(v * g_g))
    b = b.point(lambda v: util.clamp(v * b_g))
    return Image.merge("RGB", (r, g, b))


def apply_adjustments(image, params):
    """对整图应用一组调整参数（与全局节点一致的映射习惯）。"""
    out = util.ensure_rgb(image)
    b = _num(params.get("brightness"), 0.0, -ADJUST_RANGE, ADJUST_RANGE) / 100.0
    c = _num(params.get("contrast"), 0.0, -ADJUST_RANGE, ADJUST_RANGE) / 100.0
    s = _num(params.get("saturation"), 0.0, -ADJUST_RANGE, ADJUST_RANGE) / 100.0
    t = _num(params.get("temperature"), 0.0, -ADJUST_RANGE, ADJUST_RANGE)
    ti = _num(params.get("tint"), 0.0, -ADJUST_RANGE, ADJUST_RANGE)
    if abs(b) > 1e-6:
        out = ImageEnhance.Brightness(out).enhance(1.0 + b)
    if abs(t) > 1e-6:
        out = _temperature(out, t)
    if abs(ti) > 1e-6:
        out = _tint(out, ti)
    if abs(c) > 1e-6:
        out = ImageEnhance.Contrast(out).enhance(1.0 + c)
    if abs(s) > 1e-6:
        out = ImageEnhance.Color(out).enhance(1.0 + s)
    return out


def _has_effect(params, strength):
    if strength <= 1e-6:
        return False
    return any(abs(_num(params.get(k), 0.0)) > 1e-6 for k in ADJUST_KEYS)


def render(image, doc):
    """在 image 上按文档渲染全部局部调整图层。

    返回 (result_image, layer_infos)；layer_infos 给出每层覆盖率等信息，
    供前端图层面板展示。
    """
    doc = normalize_document(doc)
    base = util.ensure_rgb(image)
    cur = base
    infos = []

    for layer in doc["layers"]:
        info = {"id": layer["id"], "name": layer["name"], "visible": layer["visible"],
                "strength": layer["strength"], "params": layer["params"],
                "strokes": len(layer["strokes"]), "coverage": 0.0}
        if not layer["visible"] or not layer["strokes"]:
            infos.append(info)
            continue

        mask = rasterize_layer(layer, cur.size)
        hist = mask.histogram()
        total = sum(hist) or 1
        info["coverage"] = round(sum(c for i, c in enumerate(hist) if i > 10) / total, 4)

        if _has_effect(layer["params"], layer["strength"]):
            adjusted = apply_adjustments(cur, layer["params"])
            strength = clamp(layer["strength"], 0.0, 1.0)
            if strength < 0.999:
                mask = mask.point(lambda v: int(v * strength))
            cur = Image.composite(adjusted, cur, mask)
        infos.append(info)

    return cur, infos


def render_preview(image, doc, max_dim):
    """先降采样再渲染，用于实时预览，减少等待。"""
    work = util.downscale_to_max(util.ensure_rgb(image), max_dim)
    out, infos = render(work, doc)
    return out, infos


def mask_preview(image_size, doc):
    """生成一张红色蒙版叠加底图（调试/「显示涂抹区域」用），返回 RGB。"""
    doc = normalize_document(doc)
    w, h = image_size
    mask = Image.new("L", (w, h), 0)
    for layer in doc["layers"]:
        if layer["visible"] and layer["strokes"]:
            mask = ImageChops.add(mask, rasterize_layer(layer, (w, h)))
    red = Image.new("RGB", (w, h), (255, 60, 60))
    dark = Image.new("RGB", (w, h), (30, 34, 42))
    overlay = Image.composite(red, dark, mask.point(lambda v: int(v * 0.75)))
    return overlay


def local_adjust_node(image, params):
    """流水线节点入口：document 支持 dict 或 JSON 字符串（来自节点表单）。"""
    doc = params.get("document", {"layers": []})
    if isinstance(doc, str):
        import json as _json
        try:
            doc = _json.loads(doc)
        except (ValueError, TypeError):
            doc = {"layers": []}
    if not isinstance(doc, dict):
        doc = {"layers": []}
    result, _infos = render(image, doc)
    return result
