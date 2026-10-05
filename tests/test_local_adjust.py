"""局部调整能力测试：软边蒙版、区域限定、色温、强度、橡皮、多层叠加、
HTTP 预览/保存、保存结果可继续处理、流水线节点注册。

运行：python tests/test_local_adjust.py
不依赖网络与外部服务（Flask test_client），仅用 Pillow 读像素。
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

from server.algorithms import local_adjust as la  # noqa: E402


# ---------------------------------------------------------------------------
# 像素辅助（纯 Pillow，不引 numpy）
# ---------------------------------------------------------------------------
def px(img, x, y):
    return img.load()[x, y]


def col_profile(img, x, y0, y1):
    d = img.load()
    return [d[x, y][0] for y in range(y0, y1)]


def max_adjacent_jump(vals):
    return max(abs(vals[i + 1] - vals[i]) for i in range(len(vals) - 1))


def images_equal(a, b):
    if a.size != b.size:
        return False
    return a.tobytes() == b.tobytes()


# ---------------------------------------------------------------------------
# 算法层
# ---------------------------------------------------------------------------
def _gray(v=128, w=200, h=200):
    return Image.new("RGB", (w, h), (v, v, v))


def _layer(adj, strokes, strength=1.0, visible=True, lid="L"):
    return {"id": lid, "strength": strength, "visible": visible,
            "adjustments": adj, "strokes": strokes}


def _stroke(pts, radius=40, feather=0.5, mode="brush"):
    return {"points": [{"x": x, "y": y} for x, y in pts],
            "radius": radius, "feather": feather, "mode": mode}


def test_center_and_outside():
    out, _ = la.apply_layers(_gray(), [
        _layer({"brightness": 100}, [_stroke([(0.5, 0.5)])])])
    assert px(out, 100, 100)[0] >= 254                  # 中心满幅提亮
    assert px(out, 2, 2) == (128, 128, 128)             # 远处完全不变


def test_feather_is_smooth():
    """羽化过渡区相邻像素亮度差必须很小（无生硬色块边界）。"""
    out, _ = la.apply_layers(_gray(), [
        _layer({"brightness": 100}, [_stroke([(0.5, 0.5)], radius=40, feather=0.5)])])
    prof = col_profile(out, 100, 100, 200)
    assert max_adjacent_jump(prof) < 12
    assert prof[-1] == 128                               # 最终回到原色


def test_temperature_direction():
    warm, _ = la.apply_layers(_gray(), [
        _layer({"temperature": 100}, [_stroke([(0.5, 0.5)], feather=0.2)])])
    cool, _ = la.apply_layers(_gray(), [
        _layer({"temperature": -100}, [_stroke([(0.5, 0.5)], feather=0.2)])])
    wr, wb = px(warm, 100, 100)[0], px(warm, 100, 100)[2]
    cr, cb = px(cool, 100, 100)[0], px(cool, 100, 100)[2]
    assert wr > wb and cb > cr                           # 暖：R>B；冷：B>R


def test_strength_scales_effect():
    out, _ = la.apply_layers(_gray(), [
        _layer({"brightness": 100}, [_stroke([(0.5, 0.5)], feather=0.0)], strength=0.5)])
    v = px(out, 100, 100)[0]
    assert 185 <= v <= 200                               # 128 与 255 的中间约 191


def test_eraser_punches_hole():
    out, _ = la.apply_layers(_gray(), [
        _layer({"brightness": 100}, [
            _stroke([(0.5, 0.5)], radius=50, feather=0.0),
            _stroke([(0.5, 0.5)], radius=20, feather=0.0, mode="eraser")])])
    assert px(out, 100, 100)[0] == 128                   # 橡皮中心回到原图
    assert px(out, 145, 100)[0] > 250                    # 外圈仍被提亮


def test_long_stroke_is_continuous():
    """两个相隔很远的点之间靠插值补点，笔迹不应漏空。"""
    out, _ = la.apply_layers(_gray(w=400, h=200), [
        _layer({"brightness": 100}, [
            _stroke([(0.1, 0.5), (0.9, 0.5)], radius=12, feather=0.2)])])
    assert all(px(out, x, 100)[0] > 200 for x in range(60, 340, 20))


def test_multiple_layers_stack():
    out, meta = la.apply_layers(_gray(), [
        _layer({"brightness": 60}, [_stroke([(0.3, 0.3)], radius=30, feather=0.4)], lid="a"),
        _layer({"brightness": -60}, [_stroke([(0.7, 0.7)], radius=30, feather=0.4)], lid="b"),
    ])
    assert px(out, 60, 60)[0] > 200 and px(out, 140, 140)[0] < 60
    assert meta["layers_applied"] == 2


def test_neutral_and_hidden_layers_skipped():
    base = _gray()
    out, meta = la.apply_layers(base, [
        _layer({"brightness": 100}, []),                              # 无笔画
        _layer({"brightness": 100}, [_stroke([(0.5, 0.5)])], visible=False),
        _layer({}, [_stroke([(0.5, 0.5)])]),                         # 参数全 0
    ])
    assert images_equal(out, base)
    assert meta["layers_applied"] == 0


def test_saturation_node_entry():
    img = Image.new("RGB", (100, 100), (180, 90, 90))
    out, _ = la.apply_layers(img, [
        _layer({"saturation": -100}, [_stroke([(0.5, 0.5)], radius=30, feather=0.0)])])
    r, g, b = px(out, 50, 50)
    assert r == g == b


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------
def _client():
    from app import create_app
    app = create_app()
    return app.test_client()


def _upload(c):
    buf = io.BytesIO()
    _gray(100, 300, 200).save(buf, "PNG")
    r = c.post("/api/images",
               data={"files": (io.BytesIO(buf.getvalue()), "local_test.png")},
               content_type="multipart/form-data")
    return r.get_json()["saved"][0]["id"]


def _payload(iid):
    return {"image_id": iid, "layers": [
        {"id": "L1", "strength": 1.0, "visible": True,
         "adjustments": {"brightness": 80, "contrast": 10, "saturation": 0, "temperature": -50},
         "strokes": [{"points": [{"x": 0.25, "y": 0.5}, {"x": 0.4, "y": 0.5}],
                      "radius": 30, "feather": 0.6, "mode": "brush"}]}]}


def test_preview_cache_and_pixels():
    c = _client()
    iid = _upload(c)
    body = _payload(iid)
    r1 = c.post("/api/local-adjust", json=body).get_json()
    r2 = c.post("/api/local-adjust", json=body).get_json()
    assert r1["result_id"] and r1["layers_applied"] == 1
    assert r2["cache_hit"] is True

    data = c.get(f"/api/results/{r1['result_id']}/file").data
    out = Image.open(io.BytesIO(data)).convert("RGB")
    assert px(out, 90, 100)[0] > 150                      # 涂抹区提亮
    assert px(out, 5, 5) == (100, 100, 100)               # 区外不变


def test_save_then_continue():
    c = _client()
    iid = _upload(c)
    body = _payload(iid)
    s = c.post("/api/local-adjust/save", json=body).get_json()
    new_id = s["image"]["id"]
    assert new_id != iid and s["image"]["filename"].endswith("_局部调整.png")

    # 保存结果可以作为底图继续叠加其它处理
    run = c.post("/api/run", json={
        "image_id": new_id, "pipeline_name": "局部调整测试",
        "nodes": [{"id": "n1", "type": "contrast",
                   "params": {"amount": 30}, "inputs": []}]}).get_json()
    assert run["result_id"]


def test_registered_as_pipeline_node():
    from server import nodes as reg
    assert "local_adjust" in reg.NODES
    c = _client()
    iid = _upload(c)
    body = _payload(iid)
    run = c.post("/api/run", json={
        "image_id": iid,
        "nodes": [{"id": "n1", "type": "local_adjust",
                   "params": {"layers": body["layers"]}, "inputs": []}]}).get_json()
    assert run["result_id"]


def test_error_handling():
    c = _client()
    assert c.post("/api/local-adjust", json={"layers": []}).status_code == 404
    assert c.post("/api/local-adjust", json={"image_id": "missing", "layers": []}).status_code == 404
    assert c.post("/api/local-adjust/save", json={"layers": []}).status_code == 400


def main():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✔ {fn.__name__}")
    print(f"\n局部调整全部 {len(fns)} 项测试通过")


if __name__ == "__main__":
    main()
