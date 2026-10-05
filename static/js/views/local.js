/* 视图 11：局部调整（画笔蒙版 + 亮度/对比度/饱和度/色温，多图层可叠加）。
 *
 * 交互模型：
 * - 左侧图库选底图；中间画布涂抹（笔刷/橡皮），蒙版以红色半透明叠加显示，
 *   边缘用径向渐变软圆即时合成，所见即后端的高斯羽化效果。
 * - 右侧「图层」= 一次独立的局部调整：每处涂抹可单独调参数/强度/可见性，
 *   可撤销最后一笔、删除整层；多层按顺序叠加。
 * - 参数/笔画变化节流请求 /api/local-adjust 实时预览；
 *   「保存为新图」落盘后可在图库继续叠加其它处理。
 */
window.Views = window.Views || {};
window.Views.local = (function () {
  const C = window.Common;

  let el = null;
  let imgId = null, imgRec = null, baseImg = null;
  let layers = [], activeId = null, seq = 0;
  let tool = "brush";          // brush | eraser
  let brushSize = 0.08;        // 笔刷直径（相对图像长边，归一化）
  let feather = 0.5;           // 0..0.9
  let showMask = true;

  let viewCanvas, vctx, maskCanvas, mctx;
  let drawing = false, currentStroke = null, lastPt = null;
  let previewTimer = null, previewSeq = 0;
  let layersTimer = null;
  let resultId = null;         // 最近一次预览结果（保存时可直接基于它）

  const ADJUSTMENTS = [
    { key: "brightness", label: "亮度", min: -100, max: 100 },
    { key: "contrast", label: "对比度", min: -100, max: 100 },
    { key: "saturation", label: "饱和度", min: -100, max: 100 },
    { key: "temperature", label: "色温", min: -100, max: 100 },
  ];

  return {
    mount(root) {
      el = root;
      el.innerHTML = `
        <div class="split" style="grid-template-columns:260px 1fr 300px">
          <div class="col">
            <div class="panel"><div class="panel-title">选择底图</div><div id="la-gallery" style="max-height:300px;overflow:auto"></div></div>
            <div class="panel">
              <div class="panel-title">笔刷</div>
              <div class="toolbar">
                <button class="btn btn-sm btn-primary" id="la-tool-brush">🖌️ 笔刷</button>
                <button class="btn btn-sm" id="la-tool-eraser">🧽 橡皮</button>
              </div>
              <div class="field"><label>笔刷大小<span class="hint" id="la-size-val"></span></label>
                <input type="range" id="la-size" min="0.01" max="0.5" step="0.005" value="${brushSize}"></div>
              <div class="field"><label>羽化边缘<span class="hint" id="la-feather-val"></span></label>
                <input type="range" id="la-feather" min="0" max="0.9" step="0.02" value="${feather}"></div>
              <div class="field" style="display:flex;align-items:center;gap:6px">
                <input type="checkbox" id="la-showmask" checked style="margin:0"><label for="la-showmask" style="margin:0">显示涂抹区域（红罩）</label></div>
              <div class="toolbar" style="margin-top:4px">
                <button class="btn btn-sm" id="la-undo-stroke">↩ 撤销最后一笔</button>
                <button class="btn btn-sm" id="la-new-layer">＋ 新建调整</button>
              </div>
            </div>
          </div>

          <div class="col">
            <div class="panel">
              <div class="panel-title">涂抹调整<span class="dim">在图上按住拖动；每一处调整在右侧独立管理</span></div>
              <div class="stage" id="la-stage" style="padding:0;min-height:320px;position:relative;overflow:hidden">
                <span class="dim" id="la-hint" style="padding:48px 16px">请先在左侧选择一张图像</span>
                <canvas id="la-view" style="display:none;max-width:100%;max-height:68vh;touch-action:none;cursor:crosshair;border-radius:6px"></canvas>
              </div>
              <div class="toolbar" style="margin:12px 0 0">
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim)">
                  <input type="checkbox" id="la-preview-toggle" checked> 实时预览</label>
                <span style="flex:1"></span>
                <button class="btn" id="la-reset">全部清空</button>
                <button class="btn btn-primary" id="la-save">💾 保存为新图（可继续处理）</button>
              </div>
            </div>
            <div class="panel"><div class="panel-title">实时预览结果<span class="dim" id="la-preview-status"></span></div>
              <div class="stage" id="la-result"><span class="dim">涂抹后自动显示（节流）</span></div></div>
          </div>

          <div class="col">
            <div class="panel">
              <div class="panel-title">局部调整图层<span class="dim">每处独立可撤销/调强度</span></div>
              <div id="la-layers"></div>
            </div>
            <div class="panel" id="la-adjust-panel"></div>
          </div>
        </div>`;

      viewCanvas = el.querySelector("#la-view");
      vctx = viewCanvas.getContext("2d");
      maskCanvas = document.createElement("canvas");
      mctx = maskCanvas.getContext("2d", { willReadFrequently: false });

      C.fetchImages().then((images) => {
        el.querySelector("#la-gallery").innerHTML = C.galleryHTML(images);
        C.bindGallery(el.querySelector("#la-gallery"), images, (id, rec) => loadImage(id, rec));
      });

      el.querySelector("#la-tool-brush").onclick = () => setTool("brush");
      el.querySelector("#la-tool-eraser").onclick = () => setTool("eraser");
      el.querySelector("#la-size").oninput = (e) => { brushSize = Number(e.target.value); syncLabels(); drawView(); };
      el.querySelector("#la-feather").oninput = (e) => { feather = Number(e.target.value); syncLabels(); };
      el.querySelector("#la-showmask").onchange = (e) => { showMask = e.target.checked; drawView(); };
      el.querySelector("#la-undo-stroke").onclick = undoStroke;
      el.querySelector("#la-new-layer").onclick = () => addLayer(true);
      el.querySelector("#la-reset").onclick = resetAll;
      el.querySelector("#la-save").onclick = saveAsNew;

      bindCanvas();
      syncLabels();
      renderLayers();
      renderAdjustPanel();
    },

    refresh() {
      // 从其它页（如保存后回到本页）刷新图库
      if (!el) return;
      C.refreshImages().then((images) => {
        el.querySelector("#la-gallery").innerHTML = C.galleryHTML(images);
        C.bindGallery(el.querySelector("#la-gallery"), images, (id, rec) => loadImage(id, rec));
      });
    },
  };

  // ------------------------------------------------------------------ 图层
  function activeLayer() { return layers.find((l) => l.id === activeId) || null; }

  function newLayerData() {
    seq += 1;
    return {
      id: "la" + Date.now().toString(36) + "_" + seq,
      name: "调整 " + seq,
      strokes: [],
      strength: 1,
      visible: true,
      adjustments: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
    };
  }

  function addLayer(activate) {
    const l = newLayerData();
    layers.push(l);
    if (activate) activeId = l.id;
    renderLayers(); renderAdjustPanel(); rebuildMask(); schedulePreview();
  }

  function undoStroke() {
    const l = activeLayer();
    if (!l) { C.toast("请先新建或选择一处调整", "error"); return; }
    if (!l.strokes.length) { C.toast("当前调整没有可撤销的笔画", "error"); return; }
    l.strokes.pop();
    rebuildMask(); renderLayers(); schedulePreview();
  }

  function deleteLayer(id) {
    layers = layers.filter((l) => l.id !== id);
    if (activeId === id) activeId = layers.length ? layers[layers.length - 1].id : null;
    renderLayers(); renderAdjustPanel(); rebuildMask(); schedulePreview();
  }

  function resetAll() {
    if (!layers.length) return;
    if (!confirm("确定清空所有涂抹与调整？")) return;
    layers = []; activeId = null; resultId = null;
    renderLayers(); renderAdjustPanel(); rebuildMask();
    el.querySelector("#la-result").innerHTML = `<span class="dim">涂抹后自动显示（节流）</span>`;
  }

  // ------------------------------------------------------------------ 图像
  function loadImage(id, rec) {
    imgId = id; imgRec = rec;
    baseImg = new Image();
    baseImg.onload = () => {
      viewCanvas.width = baseImg.naturalWidth;
      viewCanvas.height = baseImg.naturalHeight;
      maskCanvas.width = baseImg.naturalWidth;
      maskCanvas.height = baseImg.naturalHeight;
      viewCanvas.style.display = "block";
      el.querySelector("#la-hint").style.display = "none";
      layers = []; seq = 0; resultId = null;
      addLayer(true);
      drawView();
    };
    baseImg.src = rec.file_url;
  }

  // ------------------------------------------------------------------ 坐标
  function radiusPx() { return brushSize * Math.max(viewCanvas.width, viewCanvas.height) / 2; }

  function eventPoint(e) {
    const rect = viewCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (viewCanvas.width / rect.width),
      y: (e.clientY - rect.top) * (viewCanvas.height / rect.height),
    };
  }

  // ------------------------------------------------------------------ 涂抹
  function bindCanvas() {
    viewCanvas.addEventListener("pointerdown", (e) => {
      if (!baseImg) return;
      if (!activeLayer()) addLayer(true);
      drawing = true;
      viewCanvas.setPointerCapture(e.pointerId);
      const p = eventPoint(e);
      currentStroke = {
        points: [{ x: norm(p.x, true), y: norm(p.y, false) }],
        radius: Math.round(radiusPx()), feather, mode: tool,
      };
      lastPt = p;
      paintDab(p, p);
      drawView();
    });
    viewCanvas.addEventListener("pointermove", (e) => {
      const p = eventPoint(e);
      if (!drawing) { drawCursor(p); return; }
      // 插值补点：快速拖动时笔迹连续（与后端一致）
      const dx = p.x - lastPt.x, dy = p.y - lastPt.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.floor(dist / Math.max(radiusPx() * 0.25, 1)));
      for (let i = 1; i <= steps; i++) {
        const ip = { x: lastPt.x + dx * i / steps, y: lastPt.y + dy * i / steps };
        currentStroke.points.push({ x: norm(ip.x, true), y: norm(ip.y, false) });
      }
      paintDab(lastPt, p);
      lastPt = p;
      drawView();
    });
    const finish = () => {
      if (!drawing) return;
      drawing = false;
      const l = activeLayer();
      if (l && currentStroke && currentStroke.points.length) {
        l.strokes.push(currentStroke);
        renderLayers();
        schedulePreview();
      }
      currentStroke = null;
      drawView();
    };
    viewCanvas.addEventListener("pointerup", finish);
    viewCanvas.addEventListener("pointercancel", finish);
    viewCanvas.addEventListener("pointerleave", () => { if (!drawing) drawView(); });
  }

  function norm(v, isX) {
    const max = isX ? viewCanvas.width : viewCanvas.height;
    return Math.max(0, Math.min(1, v / max));
  }

  /* 往离屏蒙版上画软圆。笔刷：destination-lighter 叠加；橡皮：destination-out 擦除。 */
  function paintDab(from, to) {
    const r = radiusPx();
    const steps = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(r * 0.2, 1)));
    mctx.save();
    mctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "lighter";
    for (let i = 0; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps;
      const y = from.y + (to.y - from.y) * i / steps;
      const g = mctx.createRadialGradient(x, y, r * (1 - feather), x, y, r);
      g.addColorStop(0, tool === "eraser" ? "rgba(0,0,0,1)" : "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      mctx.fillStyle = g;
      mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
    }
    mctx.restore();
  }

  /* 依据所有图层的笔画重建离屏蒙版（切层/撤销/可见性变化后调用）。 */
  function rebuildMask() {
    mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    if (!baseImg) { drawView(); return; }
    const W = maskCanvas.width, H = maskCanvas.height;
    layers.forEach((l) => {
      if (!l.visible) return;
      mctx.save();
      l.strokes.forEach((s) => {
        const r = s.radius;
        mctx.globalCompositeOperation = s.mode === "eraser" ? "destination-out" : "lighter";
        let prev = null;
        s.points.forEach((p) => {
          const x = p.x * W, y = p.y * H;
          if (prev) {
            const dist = Math.hypot(x - prev.x, y - prev.y);
            const steps = Math.max(1, Math.floor(dist / Math.max(r * 0.25, 1)));
            for (let i = 1; i <= steps; i++) stamp(prev.x + (x - prev.x) * i / steps,
                                                   prev.y + (y - prev.y) * i / steps, r, s.feather, s.mode);
          }
          stamp(x, y, r, s.feather, s.mode);
          prev = { x, y };
        });
      });
      mctx.restore();
    });
    drawView();
  }

  function stamp(x, y, r, f, mode) {
    const g = mctx.createRadialGradient(x, y, r * (1 - f), x, y, r);
    g.addColorStop(0, mode === "eraser" ? "rgba(0,0,0,1)" : "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    mctx.fillStyle = g;
    mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
  }

  // ------------------------------------------------------------------ 视图
  function drawView() {
    if (!baseImg) return;
    vctx.clearRect(0, 0, viewCanvas.width, viewCanvas.height);
    vctx.drawImage(baseImg, 0, 0);
    if (showMask) {
      // 蒙版权重 -> 红色半透明色罩（alpha 最高约 0.45）
      vctx.save();
      vctx.globalAlpha = 0.45;
      vctx.drawImage(maskCanvas, 0, 0);
      vctx.globalCompositeOperation = "source-in";
      vctx.fillStyle = tool === "eraser" ? "#ffd23d" : "#ff4d4d";
      vctx.fillRect(0, 0, viewCanvas.width, viewCanvas.height);
      vctx.restore();
    }
  }

  let cursorPt = null;
  function drawCursor(p) {
    drawView();
    vctx.save();
    vctx.strokeStyle = "rgba(255,255,255,.9)";
    vctx.lineWidth = Math.max(1, viewCanvas.width / 600);
    vctx.beginPath(); vctx.arc(p.x, p.y, radiusPx(), 0, Math.PI * 2); vctx.stroke();
    vctx.restore();
    cursorPt = p;
  }

  // ------------------------------------------------------------------ 侧栏
  function setTool(t) {
    tool = t;
    el.querySelector("#la-tool-brush").classList.toggle("btn-primary", t === "brush");
    el.querySelector("#la-tool-eraser").classList.toggle("btn-primary", t === "eraser");
  }

  function syncLabels() {
    el.querySelector("#la-size-val").textContent =
      " " + Math.round(brushSize * 100) + "% 长边";
    el.querySelector("#la-feather-val").textContent =
      " " + Math.round(feather * 100) + "%";
  }

  function renderLayers() {
    const box = el.querySelector("#la-layers");
    if (!layers.length) { box.innerHTML = `<span class="dim">尚无调整，涂抹或点「新建调整」</span>`; return; }
    box.innerHTML = layers.slice().reverse().map((l) => {
      const active = l.id === activeId;
      const strokeN = l.strokes.length;
      const a = l.adjustments;
      const summary = ["brightness", "contrast", "saturation", "temperature"]
        .filter((k) => a[k] !== 0)
        .map((k) => `${labelOf(k)} ${a[k] > 0 ? "+" : ""}${a[k]}`).join(" · ") || "未调整";
      return `
      <div class="card la-layer ${active ? "selected" : ""}" data-id="${l.id}" style="padding:10px;margin-bottom:8px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:6px">
          <span title="${l.visible ? "隐藏" : "显示"}" data-vis="${l.id}" style="cursor:pointer">${l.visible ? "👁" : "🚫"}</span>
          <strong style="font-size:13px">${C.esc(l.name)}</strong>
          <span style="flex:1"></span>
          <span class="badge">${strokeN} 笔</span>
          <button class="btn btn-sm btn-danger" data-del="${l.id}">删除</button>
        </div>
        <div class="dim" style="font-size:11px;margin-top:4px">${C.esc(summary)} · 强度 ${Math.round(l.strength * 100)}%</div>
      </div>`;
    }).join("");

    box.querySelectorAll(".la-layer").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-del],[data-vis]")) return;
        activeId = card.dataset.id;
        renderLayers(); renderAdjustPanel();
      });
    });
    box.querySelectorAll("[data-del]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation(); deleteLayer(b.dataset.del);
    });
    box.querySelectorAll("[data-vis]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const l = layers.find((x) => x.id === b.dataset.vis);
      if (l) { l.visible = !l.visible; renderLayers(); rebuildMask(); schedulePreview(); }
    });
  }

  function labelOf(k) { return (ADJUSTMENTS.find((x) => x.key === k) || {}).label || k; }

  function renderAdjustPanel() {
    const panel = el.querySelector("#la-adjust-panel");
    const l = activeLayer();
    if (!l) { panel.innerHTML = `<div class="panel-title">调整参数</div><span class="dim">选择或新建一处调整</span>`; return; }
    panel.innerHTML = `<div class="panel-title">${C.esc(l.name)}<span class="dim">仅作用于该处涂抹区域</span></div>
      <div class="field" style="margin-bottom:14px"><label>整体强度<span class="hint" id="la-strength-val">${Math.round(l.strength * 100)}%</span></label>
        <input type="range" id="la-strength" min="0" max="1" step="0.02" value="${l.strength}"></div>` +
      ADJUSTMENTS.map((adj) => `
        <div class="field"><label>${adj.label}<span class="hint" data-adj-val="${adj.key}">${fmtAdj(l.adjustments[adj.key])}</span></label>
          <div class="range-row">
            <input type="range" data-adj="${adj.key}" min="${adj.min}" max="${adj.max}" value="${l.adjustments[adj.key]}">
            <span class="range-val">${l.adjustments[adj.key]}</span>
          </div></div>`).join("") +
      `<div class="toolbar" style="margin-top:6px"><button class="btn btn-sm" id="la-zero-adj">参数归零</button></div>`;

    panel.querySelector("#la-strength").oninput = (e) => {
      l.strength = Number(e.target.value);
      panel.querySelector("#la-strength-val").textContent = Math.round(l.strength * 100) + "%";
      schedulePreview(); renderLayersSoon();
    };
    panel.querySelectorAll("[data-adj]").forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.adj, v = Number(inp.value);
        l.adjustments[k] = v;
        panel.querySelector(`[data-adj-val="${k}"]`).textContent = fmtAdj(v);
        inp.parentElement.querySelector(".range-val").textContent = v;
        schedulePreview(); renderLayersSoon();
      };
    });
    panel.querySelector("#la-zero-adj").onclick = () => {
      ADJUSTMENTS.forEach((a) => l.adjustments[a.key] = 0);
      renderAdjustPanel(); renderLayers(); schedulePreview();
    };
  }

  function renderLayersSoon() {
    clearTimeout(layersTimer);
    layersTimer = setTimeout(renderLayers, 300);
  }

  function fmtAdj(v) {
    if (v === 0) return " 0";
    return " " + (v > 0 ? "+" : "") + v + (v !== 0 ? "　" : "");
  }

  // ------------------------------------------------------------------ 预览/保存
  function buildPayload() {
    return {
      layers: layers.filter((l) => l.strokes.length).map((l) => ({
        id: l.id, visible: l.visible, strength: l.strength,
        adjustments: l.adjustments,
        strokes: l.strokes.map((s) => ({
          points: s.points, radius: s.radius, feather: s.feather, mode: s.mode,
        })),
      })),
    };
  }

  function hasEffect() {
    return layers.some((l) => l.visible && l.strokes.length &&
      (l.strength > 0) &&
      Object.values(l.adjustments).some((v) => v !== 0));
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    if (!imgId) return;
    const live = el.querySelector("#la-preview-toggle").checked;
    if (!live || !hasEffect()) {
      if (!hasEffect()) el.querySelector("#la-result").innerHTML =
        `<span class="dim">涂抹并调整参数后显示</span>`;
      return;
    }
    previewTimer = setTimeout(runPreview, 300);
  }

  async function runPreview() {
    const status = el.querySelector("#la-preview-status");
    status.textContent = "计算中…";
    const my = ++previewSeq;
    try {
      const r = await Api.post("/api/local-adjust", { image_id: imgId, ...buildPayload() });
      if (my !== previewSeq) return; // 已有更新的请求
      resultId = r.result_id;
      el.querySelector("#la-result").innerHTML =
        `<img src="${r.file_url}?t=${Date.now()}"><div class="caption">${r.layers_applied} 处调整 · ${r.cache_hit ? "缓存命中" : "已计算"}</div>`;
      status.textContent = "";
    } catch (e) {
      if (my === previewSeq) status.textContent = "失败：" + e.message;
    }
  }

  async function saveAsNew() {
    if (!imgId) { C.toast("请先选择底图", "error"); return; }
    if (!hasEffect()) { C.toast("还没有任何调整效果", "error"); return; }
    const btn = el.querySelector("#la-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const r = await Api.post("/api/local-adjust/save", { image_id: imgId, ...buildPayload() });
      C.toast(`已保存为「${r.image.filename}」，可在图库继续处理`, "success");
      await C.refreshImages();
      refreshGallery();
    } catch (e) {
      C.toast("保存失败：" + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "💾 保存为新图（可继续处理）";
    }
  }

  function refreshGallery() {
    C.fetchImages().then((images) => {
      el.querySelector("#la-gallery").innerHTML = C.galleryHTML(images);
      C.bindGallery(el.querySelector("#la-gallery"), images, (id, rec) => loadImage(id, rec));
    });
  }
})();
