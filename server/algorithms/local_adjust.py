"""局部调整算法：基于画笔蒙版对任意区域单独做亮度/对比度/饱和度/色温调整。

核心思路：

- 前端把每一笔涂抹记录为「归一化坐标点序列 + 笔刷半径 + 羽化」，后端在图像
  坐标系里逐点「盖印章」（draw.ellipse）光栅化出蒙版，天然与分辨率无关。
- 软边缘 = 实心内核 + 高斯模糊。每个点先画半径 r*(1-feather) 的实心圆，再对
  整张笔画蒙版做 sigma = r*feather/2 的高斯模糊；中心区域保持 255，边缘按
  高斯曲线衰减到 0，保证涂抹边缘自然过渡、不出现生硬色块。同一笔画相邻点
  间距小于半径，印章彼此重叠，笔迹粗细均匀。
- 同一图层内多笔画用「取亮」(lighten) 合并；橡皮笔刷用减法擦除。
- 每个图层可以带独立的亮度/对比度/饱和度/色温参数与整体强度 strength：
  先在整图上算出「全效果图」，再按蒙版 alpha（再乘 strength）与原图合成，
  边缘像素是 原图/效果图 的线性插值，过渡连续。
- 多个图层按顺序依次合成到基础图上，实现「可叠加多次涂抹」。
"""
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

from . import util

# 单项参数范围（与前端滑块一致）
AMOUNT_MIN, AMOUNT_MAX = -100, 100
FEATHER_MIN, FEATHER_MAX = 0.0, 0.9
STRENGTH_MIN, STRENGTH_MAX = 0.0, 1.0


# ---------------------------------------------------------------------------
# 参数清洗
# ---------------------------------------------------------------------------
def _clamp(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _clean_stroke(stroke, w, h):
    """把一条笔画清洗成 (points, radius_px, feather, mode)。"""
    radius = _clamp(stroke.get("radius", 40), 1, max(w, h), 40)
    feather = _clamp(stroke.get("feather", 0.5), FEATHER_MIN, FEATHER_MAX, 0.5)
    mode = stroke.get("mode", "brush")
    if mode not in ("brush", "eraser"):
        mode = "brush"
    pts = []
    for p in stroke.get("points") or []:
        try:
            if isinstance(p, dict):
                nx, ny = p.get("x"), p.get("y")
            else:
                nx, ny = p[0], p[1]
            nx = _clamp(nx, 0.0, 1.0, None)
            ny = _clamp(ny, 0.0, 1.0, None)
        except (AttributeError, IndexError, TypeError, KeyError):
            continue
        if nx is None or ny is None:
            continue
        pts.append((nx * w, ny * h))
    return pts, radius, feather, mode


# ---------------------------------------------------------------------------
# 蒙版光栅化
# ---------------------------------------------------------------------------
def _rasterize_dab(mask, x, y, radius, feather):
    """在蒙版上盖一个软边圆印章，并与已有内容取亮合并。

    画半径为 radius 的实心圆再做 sigma=radius*feather/2 的高斯模糊：
    模糊对圆盘内部的影响在约 2*sigma = radius*feather 处衰减到接近 0，
    因此 radius*(1-feather) 以内保持 255（实心涂抹），再向外按高斯曲线
    平滑衰减到 0，中心不虚、边缘自然。
    """
    dab = Image.new("L", mask.size, 0)
    d = ImageDraw.Draw(dab)
    d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=255)
    if feather > 0.01:
        dab = dab.filter(ImageFilter.GaussianBlur(max(radius * feather * 0.5, 0.1)))
    return ImageChops.lighter(mask, dab)


def _rasterize_stroke(size, stroke):
    """把一条笔画光栅化为一张灰度软蒙版（255 = 完全涂抹）。"""
    w, h = size
    pts, radius, feather, mode = _clean_stroke(stroke, w, h)
    mask = Image.new("L", size, 0)
    if not pts:
        return mask, mode

    prev = None
    for x, y in pts:
        if prev is None:
            interp = [(x, y)]
        else:
            # 沿上一点到当前点插值补点，间距不超过半径的 1/4，
            # 保证快速拖动画笔时笔迹连续、不漏空
            dx, dy = x - prev[0], y - prev[1]
            dist = (dx * dx + dy * dy) ** 0.5
            steps = max(1, int(dist / max(radius * 0.25, 1.0)))
            interp = [(prev[0] + dx * i / steps, prev[1] + dy * i / steps)
                      for i in range(1, steps + 1)]
        for ix, iy in interp:
            mask = _rasterize_dab(mask, ix, iy, radius, feather)
        prev = (x, y)
    return mask, mode


def build_layer_mask(size, strokes):
    """合并同一图层的所有笔画：笔刷取亮、橡皮减去。"""
    mask = Image.new("L", size, 0)
    for stroke in strokes or []:
        dab, mode = _rasterize_stroke(size, stroke)
        if mode == "eraser":
            mask = ImageChops.subtract(mask, dab)
        else:
            mask = ImageChops.lighter(mask, dab)
    return mask


# ---------------------------------------------------------------------------
# 单图层的全效果调整（不含蒙版，整图计算后由调用方按蒙版合成）
# ---------------------------------------------------------------------------
def _adjust_full(image, adj):
    """在整图上计算亮度/对比度/饱和度/色温的全效果。"""
    out = util.ensure_rgb(image)

    brightness = _clamp(adj.get("brightness", 0), AMOUNT_MIN, AMOUNT_MAX, 0)
    contrast = _clamp(adj.get("contrast", 0), AMOUNT_MIN, AMOUNT_MAX, 0)
    saturation = _clamp(adj.get("saturation", 0), AMOUNT_MIN, AMOUNT_MAX, 0)
    temperature = _clamp(adj.get("temperature", 0), AMOUNT_MIN, AMOUNT_MAX, 0)

    if brightness:
        out = ImageEnhance.Brightness(out).enhance(1.0 + brightness / 100.0)
    if contrast:
        out = ImageEnhance.Contrast(out).enhance(1.0 + contrast / 100.0)
    if saturation:
        out = ImageEnhance.Color(out).enhance(1.0 + saturation / 100.0)
    if temperature:
        # 色温：正数偏暖（提红压蓝），负数偏冷（提蓝压红），绿色通道轻微补偿
        k = temperature / 100.0
        r_gain = 1.0 + 0.22 * k
        g_gain = 1.0 + 0.08 * k
        b_gain = 1.0 - 0.22 * k
        r, g, b = out.split()
        r = r.point(lambda v: util.clamp(v * r_gain))
        g = g.point(lambda v: util.clamp(v * g_gain))
        b = b.point(lambda v: util.clamp(v * b_gain))
        out = Image.merge("RGB", (r, g, b))
    return out


def _clean_layer(layer):
    """清洗单个图层定义，返回标准化 dict。"""
    adj = layer.get("adjustments") or {}
    strokes = []
    for s in layer.get("strokes") or []:
        pts = [p for p in (s.get("points") or [])]
        if not pts:
            continue
        strokes.append({
            "points": pts,
            "radius": s.get("radius", 40),
            "feather": s.get("feather", 0.5),
            "mode": s.get("mode", "brush"),
        })
    return {
        "id": str(layer.get("id") or "layer"),
        "strokes": strokes,
        "strength": _clamp(layer.get("strength", 1.0), STRENGTH_MIN, STRENGTH_MAX, 1.0),
        "visible": bool(layer.get("visible", True)),
        "brightness": _clamp(adj.get("brightness", 0), AMOUNT_MIN, AMOUNT_MAX, 0),
        "contrast": _clamp(adj.get("contrast", 0), AMOUNT_MIN, AMOUNT_MAX, 0),
        "saturation": _clamp(adj.get("saturation", 0), AMOUNT_MIN, AMOUNT_MAX, 0),
        "temperature": _clamp(adj.get("temperature", 0), AMOUNT_MIN, AMOUNT_MAX, 0),
    }


def _layer_is_neutral(layer):
    return not any((layer["brightness"], layer["contrast"],
                    layer["saturation"], layer["temperature"]))


def apply_layers(image, layers):
    """按顺序把全部局部调整图层叠加到 image 上。

    layers: [{
        id, visible, strength,
        adjustments: {brightness, contrast, saturation, temperature},
        strokes: [{points: [{x,y} 归一化], radius(px), feather(0..0.9), mode}]
    }]
    返回 (结果图, meta)。
    """
    base = util.ensure_rgb(image)
    layers = [_clean_layer(l) for l in (layers or [])]

    applied = 0
    coverage = 0.0
    for layer in layers:
        if not layer["visible"] or not layer["strokes"] or _layer_is_neutral(layer) \
                or layer["strength"] <= 0:
            continue
        mask = build_layer_mask(base.size, layer["strokes"])
        if layer["strength"] < 1.0:
            mask = mask.point(lambda v: int(v * layer["strength"]))
        if mask.getextrema() == (0, 0):
            continue

        adjusted = _adjust_full(base, layer)
        base = Image.composite(adjusted, base, mask)
        applied += 1
        hist = mask.histogram()
        coverage = max(coverage, sum(i * c for i, c in enumerate(hist))
                       / (255.0 * (base.size[0] * base.size[1])))

    return base, {"layers_applied": applied, "mask_coverage": round(coverage, 4)}


def local_adjust(image, params):
    """节点/单图接口统一入口。params.layers 为图层列表。"""
    layers = params.get("layers") or []
    out, meta = apply_layers(image, layers)
    return {"image": out, **meta}
