/* 视图：局部调整（画笔涂抹 + 分区亮度/对比度/饱和度/色温）。
 *
 * 交互模型：
 * - 左侧选底图（图库，含已提交的结果图，可继续叠加）；
 * - 中间舞台 = 服务端渲染结果 <img> + 同尺寸蒙版叠加 <canvas>，
 *   涂抹时本地即时反馈，松手后节流请求 /api/local/render 得到权威结果；
 * - 每个「调整图层」独立保存笔触与参数：可改名、可见性、整体强度、删除；
 * - undo/redo 记录文档快照（笔触完成、增删图层）；
 * - 导出走 /api/local/commit 全分辨率入库；工程（涂抹数据）可保存/重新打开。
 */
window.Views = window.Views || {};
window.Views.local = (function () {
  const C = window.Common;

  const ADJUSTS = [
    { key: "brightness", label: "亮度", min: -100, max: 100 },
    { key: "contrast", label: "对比度", min: -100, max: 100 },
    { key: "saturation", label: "饱和度", min: -100, max: 100 },
    { key: "temperature", label: "色温", min: -100, max: 100, hint: "冷 ← → 暖" },
    { key: "tint", label: "色调", min: -100, max: 100, hint: "品红 ← → 绿" },
  ];

  const state = {
    el: null,
    image: null,            // 底图记录
    doc: { layers: [] },    // 与后端一致的文档结构
    currentId: null,
    tool: "paint",          // paint / erase
    brush: { size: 0.08, feather: 0.35, flow: 0.7 },
    showMask: false,
    masks: {},              // layerId -> 离屏 canvas（本地蒙版）
    history: [], future: [],
    docId: null,
    renderSeq: 0,
    renderTimer: null,
    painting: false,
    activePts: null,
  };

  return {
    mount(el) {
      state.el = el;
      el.innerHTML = `
        <div class="split" style="grid-template-columns:300px 1fr 260px">
          <div class="col">
            <div class="panel">
              <div class="panel-title">选择底图<span class="dim">结果图也可继续叠加</span></div>
              <div id="la-gallery" style="max-height:240px;overflow:auto"></div>
            </div>
            <div class="panel">
              <div class="panel-title">画笔</div>
              <div class="la-tools">
                <button class="btn btn-sm la-tool active" data-tool="paint">🖌️ 画笔</button>
                <button class="btn btn-sm la-tool" data-tool="erase">◌ 橡皮</button>
              </div>
              ${slider("大小", "la-size", 1, 40, 1, 8, "% 图宽")}
              ${slider("羽化", "la-feather", 0, 100, 1, 35, "%")}
              ${slider("流量", "la-flow", 5, 100, 1, 70, "%")}
              <label class="la-check"><input type="checkbox" id="la-mask"> 显示涂抹区域</label>
            </div>
            <div class="panel">
              <div class="panel-title">工程</div>
              <div class="toolbar">
                <button class="btn btn-sm" id="la-save-doc">💾 保存工程</button>
                <button class="btn btn-sm" id="la-open-doc">📂 打开</button>
              </div>
              <div id="la-doc-name" class="dim" style="font-size:12px"></div>
            </div>
          </div>

          <div class="col">
            <div class="panel">
              <div class="toolbar" style="margin-bottom:10px">
                <button class="btn btn-sm" id="la-undo" title="撤销 (Ctrl+Z)">↶ 撤销</button>
                <button class="btn btn-sm" id="la-redo" title="重做 (Ctrl+Y)">↷ 重做</button>
                <button class="btn btn-sm" id="la-add-layer">＋ 新增调整</button>
                <span style="flex:1"></span>
                <span id="la-status" class="dim" style="font-size:12px"></span>
                <button class="btn btn-sm btn-primary" id="la-commit">⬇ 导出为新图像</button>
              </div>
              <div class="stage la-stage" id="la-stage">
                <div class="empty"><span class="big">🖌️</span>从左侧选择一张图像开始局部调整</div>
              </div>
              <div class="dim" style="font-size:12px;margin-top:8px">
                提示：按住鼠标在画面上涂抹；不同调整请「新增调整」分层，每层独立参数、强度与撤销。
              </div>
            </div>
          </div>

          <div class="col">
            <div class="panel">
              <div class="panel-title">当前调整参数<span class="dim" id="la-layer-name"></span></div>
              <div id="la-params"></div>
              ${slider("整体强度", "la-strength", 0, 100, 1, 100, "%")}
            </div>
            <div class="panel">
              <div class="panel-title">调整图层<span class="dim">每处独立</span></div>
              <div id="la-layers"></div>
            </div>
          </div>
        </div>`;

      loadGallery(el);
      bindStaticControls(el);
      window.addEventListener("resize", C.debounce(() => {
        if (state.image && state.el.closest(".view.active")) {
          setupCanvas();
          state.doc.layers.forEach((l) => rebuildLayerMask(l));
          drawOverlay();
        }
      }, 200));
      refreshUndoButtons();
    },
    refresh() { loadGallery(state.el, state.image && state.image.id); },
  };

  // ---------------------------------------------------------------- 小部件
  function slider(label, id, min, max, step, val, unit) {
    return `<div class="field"><label>${label}</label>
      <div class="range-row">
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
        <span class="range-val" id="${id}-val">${val}${unit || ""}</span>
      </div></div>`;
  }

  function bindRange(id, fn, unit, live) {
    const inp = state.el.querySelector("#" + id);
    const out = state.el.querySelector("#" + id + "-val");
    inp.addEventListener("input", () => {
      out.textContent = inp.value + (unit || "");
      fn(Number(inp.value), live);
    });
  }

  // ---------------------------------------------------------------- 图库
  async function loadGallery(el, selectId) {
    const images = await C.fetchImages();
    const box = el.querySelector("#la-gallery");
    box.innerHTML = C.galleryHTML(images);
    C.bindGallery(box, images, (id, rec) => selectImage(rec, images));
    const want = selectId || (state.image && state.image.id);
    if (want) {
      const card = box.querySelector(`.card[data-id="${want}"]`);
      if (card) card.classList.add("selected");
    }
  }

  // ---------------------------------------------------------------- 控件
  function bindStaticControls(el) {
    el.querySelector(".la-tools").addEventListener("click", (e) => {
      const b = e.target.closest(".la-tool");
      if (!b) return;
      state.tool = b.dataset.tool;
      el.querySelectorAll(".la-tool").forEach((x) => x.classList.toggle("active", x === b));
    });

    bindRange("la-size", (v) => { state.brush.size = v / 100; }, "% 图宽");
    bindRange("la-feather", (v) => { state.brush.feather = v / 100; }, "%");
    bindRange("la-flow", (v) => { state.brush.flow = v / 100; }, "%");

    el.querySelector("#la-mask").addEventListener("change", (e) => {
      state.showMask = e.target.checked;
      drawOverlay();
    });

    el.querySelector("#la-add-layer").onclick = () => addLayer();
    el.querySelector("#la-undo").onclick = undo;
    el.querySelector("#la-redo").onclick = redo;
    el.querySelector("#la-commit").onclick = commitImage;
    el.querySelector("#la-save-doc").onclick = saveDoc;
    el.querySelector("#la-open-doc").onclick = openDocMenu;

    // 只在 document 上监听一次（避免 el + document 双重触发导致一次按键撤销两步）
    document.addEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (!state.el || !state.el.closest(".view.active")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  }

  // ---------------------------------------------------------------- 会话
  function selectImage(rec) {
    state.image = rec;
    state.doc = { layers: [] };
    state.history = []; state.future = [];
    state.masks = {}; state.docId = null;
    addLayer(true);
    buildStage(rec);
    state.el.querySelector("#la-doc-name").textContent = "";
  }

  function currentLayer() {
    return state.doc.layers.find((l) => l.id === state.currentId) || null;
  }

  function addLayer(silent) {
    const n = state.doc.layers.length + 1;
    const layer = {
      id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: `调整 ${n}`, visible: true, strength: 1,
      params: { brightness: 25, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
      strokes: [],
    };
    if (!silent) pushHistory();
    state.doc.layers.push(layer);
    state.currentId = layer.id;
    state.masks[layer.id] = makeMaskCanvas();
    renderParams();
    renderLayerList();
    refreshUndoButtons();
    scheduleRender();
  }

  // ---------------------------------------------------------------- 舞台
  function buildStage(rec) {
    const stage = state.el.querySelector("#la-stage");
    stage.classList.add("la-stage-on");
    stage.innerHTML = `
      <div class="la-wrap" id="la-wrap">
        <img id="la-img" alt="" draggable="false">
        <canvas id="la-canvas"></canvas>
        <div class="la-ring" id="la-ring" hidden></div>
      </div>`;
    const img = stage.querySelector("#la-img");
    img.src = rec.file_url;
    img.onload = () => {
      setupCanvas();
      // 按笔触数据重建全部蒙版（首次载入/打开工程/窗口尺寸变化后）
      state.doc.layers.forEach((l) => rebuildLayerMask(l));
      // 此时 DOM 就绪，刷新参数/图层面板并请求权威渲染
      renderParams();
      renderLayerList();
      refreshUndoButtons();
      drawOverlay();
      scheduleRender();
    };
    bindPaint(stage);
  }

  function setupCanvas() {
    const img = state.el.querySelector("#la-img");
    const cv = state.el.querySelector("#la-canvas");
    const rect = img.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(rect.width * dpr));
    cv.height = Math.max(1, Math.round(rect.height * dpr));
    cv.style.width = rect.width + "px";
    cv.style.height = rect.height + "px";
    cv._dpr = dpr;
    // 离屏蒙版按同一像素分辨率
    Object.values(state.masks).forEach((m) => {
      if (m.width !== cv.width || m.height !== cv.height) {
        m.width = cv.width; m.height = cv.height;
      }
    });
  }

  function makeMaskCanvas() {
    const cv = state.el.querySelector("#la-canvas");
    const m = document.createElement("canvas");
    if (cv) { m.width = cv.width; m.height = cv.height; }
    return m;
  }

  // ---------------------------------------------------------------- 涂抹
  function bindPaint(stage) {
    const cv = stage.querySelector("#la-canvas");
    const ring = stage.querySelector("#la-ring");

    cv.addEventListener("pointerdown", (e) => {
      const layer = currentLayer();
      if (!layer) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      state.painting = true;
      const p = eventNorm(e);
      state.activePts = [p];
      state.activeStroke = {
        type: state.tool, size: state.brush.size, feather: state.brush.feather,
        flow: state.brush.flow, points: [p],
      };
      paintActiveStroke();
    });

    cv.addEventListener("pointermove", (e) => {
      moveRing(e, ring);
      if (!state.painting) return;
      const p = eventNorm(e);
      const last = state.activePts[state.activePts.length - 1];
      // 过滤过近的点，但保留拖动轨迹（服务端/本地都会再插值）
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.0015) {
        state.activePts.push(p);
        state.activeStroke.points = state.activePts;
        paintActiveStroke();
      }
    });

    const finish = () => {
      if (!state.painting) return;
      state.painting = false;
      const stroke = state.activeStroke;
      state.activeStroke = null; state.activePts = null;
      const layer = currentLayer();
      if (layer && stroke && stroke.points.length) {
        pushHistory();
        layer.strokes.push(stroke);
        // 将本次笔触并入该层持久蒙版
        commitActiveToMask(layer.id, stroke);
        renderLayerList();
        scheduleRender();
      } else {
        drawOverlay();
      }
    };
    cv.addEventListener("pointerup", finish);
    cv.addEventListener("pointercancel", finish);
    cv.addEventListener("pointerleave", () => { ring.hidden = true; });
  }

  function eventNorm(e) {
    const img = state.el.querySelector("#la-img");
    const r = img.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  }

  function moveRing(e, ring) {
    const img = state.el.querySelector("#la-img");
    const r = img.getBoundingClientRect();
    const radiusPx = state.brush.size * r.width;
    ring.hidden = false;
    ring.style.width = ring.style.height = (radiusPx * 2) + "px";
    ring.style.left = (e.clientX - r.left - radiusPx) + "px";
    ring.style.top = (e.clientY - r.top - radiusPx) + "px";
  }

  /* 画一个软边印戳：内核实、外缘按羽化比例线性衰减到透明。 */
  function dab(ctx, nx, ny, size, feather, alpha, op) {
    const cv = state.el.querySelector("#la-canvas");
    const x = nx * cv.width, y = ny * cv.height;
    const radius = size * cv.width;
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = op || "source-over";
    const g = ctx.createRadialGradient(x, y, Math.max(0.1, radius * (1 - feather)), x, y, radius);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = prev;
  }

  function strokeDabs(ctx, stroke, op) {
    const pts = stroke.points;
    const alpha = stroke.type === "erase" ? 1.0 : stroke.flow;
    // 相邻点按半径的 18% 间距（归一化单位）插值，快速拖动不留缝
    const stepN = Math.max(0.0015, stroke.size * 0.18);
    let prev = pts[0];
    const put = (p) => dab(ctx, p[0], p[1], stroke.size, stroke.feather, alpha, op);
    put(prev);
    for (const cur of pts.slice(1)) {
      const d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      const n = Math.max(1, Math.ceil(d / stepN));
      for (let k = 1; k <= n; k++) {
        put([prev[0] + (cur[0] - prev[0]) * k / n, prev[1] + (cur[1] - prev[1]) * k / n]);
      }
      prev = cur;
    }
  }

  function commitActiveToMask(layerId, stroke) {
    const mask = state.masks[layerId];
    if (!mask) return;
    const ctx = mask.getContext("2d");
    strokeDabs(ctx, stroke, stroke.type === "erase" ? "destination-out" : "source-over");
  }

  function paintActiveStroke() {
    // 正在画时：基于当前层蒙版的临时副本叠加/擦除，再连同其它可见层一起显示
    const layer = currentLayer();
    if (!layer) return;
    const base = state.masks[layer.id] || makeMaskCanvas();
    const tmp = document.createElement("canvas");
    tmp.width = base.width; tmp.height = base.height;
    tmp.getContext("2d").drawImage(base, 0, 0);
    if (state.activeStroke) {
      strokeDabs(tmp.getContext("2d"), state.activeStroke,
        state.activeStroke.type === "erase" ? "destination-out" : "source-over");
    }
    drawOverlay(tmp);
  }

  /* 由笔触数据重建某层蒙版（撤销/重做/窗口尺寸变化后）。 */
  function rebuildLayerMask(layer) {
    const cv = state.el.querySelector("#la-canvas");
    const m = document.createElement("canvas");
    m.width = cv.width; m.height = cv.height;
    const ctx = m.getContext("2d");
    layer.strokes.forEach((s) => {
      strokeDabs(ctx, s, s.type === "erase" ? "destination-out" : "source-over");
    });
    state.masks[layer.id] = m;
  }

  /* 把全部可见层蒙版合成红色叠加；activeOverride 为正在画的临时层蒙版。 */
  function drawOverlay(activeOverride) {
    const cv = state.el.querySelector("#la-canvas");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!state.showMask && !state.painting) return;

    const union = document.createElement("canvas");
    union.width = cv.width; union.height = cv.height;
    const uctx = union.getContext("2d");
    state.doc.layers.forEach((l) => {
      if (!l.visible) return;
      let m = state.masks[l.id];
      if (l.id === state.currentId && activeOverride) m = activeOverride;
      if (m) ucts.drawImage(m, 0, 0);
    });

    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.drawImage(union, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#ff4d5e";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 参数面板
  function renderParams() {
    const layer = currentLayer();
    const box = state.el.querySelector("#la-params");
    const nameBox = state.el.querySelector("#la-layer-name");
    if (!layer) {
      box.innerHTML = `<div class="empty" style="padding:16px">暂无图层</div>`;
      nameBox.textContent = "";
      state.el.querySelector("#la-strength").disabled = true;
      state.el.querySelector("#la-strength").value = 100;
      state.el.querySelector("#la-strength-val").textContent = "100%";
      return;
    }
    nameBox.textContent = layer.name ? `· ${layer.name}` : "";
    box.innerHTML = ADJUSTS.map((a) => {
      const v = layer.params[a.key] || 0;
      return `<div class="field"><label>${a.label}${a.hint ? `<span class="hint">${a.hint}</span>` : ""}</label>
        <div class="range-row">
          <input type="range" data-k="${a.key}" min="${a.min}" max="${a.max}" value="${v}">
          <span class="range-val" data-v="${a.key}">${v}</span>
        </div></div>`;
    }).join("");
    box.querySelectorAll("input[data-k]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const k = inp.dataset.k;
        layer.params[k] = Number(inp.value);
        box.querySelector(`[data-v="${k}"]`).textContent = inp.value;
        scheduleRender();
      });
    });
    const sInp = state.el.querySelector("#la-strength");
    sInp.disabled = false;
    sInp.value = Math.round(layer.strength * 100);
    state.el.querySelector("#la-strength-val").textContent = sInp.value + "%";
    sInp.oninput = () => {
      layer.strength = Number(sInp.value) / 100;
      state.el.querySelector("#la-strength-val").textContent = sInp.value + "%";
      scheduleRender();
    };
  }

  // ---------------------------------------------------------------- 图层列表
  function renderLayerList(infos) {
    const box = state.el.querySelector("#la-layers");
    if (!state.doc.layers.length) {
      box.innerHTML = `<span class="dim">还没有调整图层</span>`;
      return;
    }
    const infoById = {};
    (infos || []).forEach((i) => { infoById[i.id] = i; });
    box.innerHTML = state.doc.layers.slice().reverse().map((l) => {
      const active = l.id === state.currentId;
      const info = infoById[l.id] || {};
      const cov = info.coverage != null ? `· 覆盖 ${(info.coverage * 100).toFixed(0)}%` : "";
      return `<div class="la-layer ${active ? "active" : ""}" data-id="${l.id}">
        <button class="la-eye" data-eye="${l.id}" title="显隐">${l.visible ? "👁" : "—"}</button>
        <div class="la-layer-main" data-pick="${l.id}">
          <input type="text" class="la-layer-name" data-name="${l.id}" value="${C.esc(l.name)}">
          <div class="la-layer-meta">${l.strokes.length} 笔 ${cov} · 强度 ${Math.round(l.strength * 100)}%</div>
        </div>
        <button class="btn btn-sm btn-danger la-del" data-del="${l.id}">删</button>
      </div>`;
    }).join("");

    box.querySelectorAll("[data-pick]").forEach((el) => el.onclick = () => {
      state.currentId = el.dataset.pick;
      renderParams(); renderLayerList(infos); drawOverlay();
    });
    box.querySelectorAll("[data-eye]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const l = state.doc.layers.find((x) => x.id === b.dataset.eye);
      if (l) { l.visible = !l.visible; renderLayerList(infos); scheduleRender(); drawOverlay(); }
    });
    box.querySelectorAll("[data-del]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      deleteLayer(b.dataset.del);
    });
    box.querySelectorAll("[data-name]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const l = state.doc.layers.find((x) => x.id === inp.dataset.name);
        if (l) l.name = inp.value;
      });
      inp.addEventListener("click", (e) => e.stopPropagation());
    });
  }

  function deleteLayer(id) {
    pushHistory();
    state.doc.layers = state.doc.layers.filter((l) => l.id !== id);
    delete state.masks[id];
    if (state.currentId === id) {
      state.currentId = state.doc.layers.length ? state.doc.layers[state.doc.layers.length - 1].id : null;
    }
    if (!state.doc.layers.length) addLayer(true);
    renderParams(); renderLayerList(); refreshUndoButtons(); drawOverlay();
    scheduleRender();
  }

  // ---------------------------------------------------------------- 撤销重做
  function cloneDoc() { return JSON.parse(JSON.stringify(state.doc)); }

  function pushHistory() {
    state.history.push(cloneDoc());
    if (state.history.length > 50) state.history.shift();
    state.future = [];
    refreshUndoButtons();
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(cloneDoc());
    state.doc = state.history.pop();
    restoreDoc();
  }

  function redo() {
    if (!state.future.length) return;
    state.history.push(cloneDoc());
    state.doc = state.future.pop();
    restoreDoc();
  }

  function restoreDoc() {
    if (!state.doc.layers.some((l) => l.id === state.currentId)) {
      state.currentId = state.doc.layers.length ? state.doc.layers[state.doc.layers.length - 1].id : null;
    }
    Object.keys(state.masks).forEach((k) => delete state.masks[k]);
    state.doc.layers.forEach((l) => rebuildLayerMask(l));
    renderParams(); renderLayerList(); refreshUndoButtons(); drawOverlay();
    scheduleRender();
  }

  function refreshUndoButtons() {
    const u = state.el && state.el.querySelector("#la-undo");
    if (!u) return;
    u.disabled = !state.history.length;
    state.el.querySelector("#la-redo").disabled = !state.future.length;
  }

  // ---------------------------------------------------------------- 渲染
  function scheduleRender() {
    clearTimeout(state.renderTimer);
    const status = state.el.querySelector("#la-status");
    state.renderTimer = setTimeout(doRender, 280);
    if (status && hasAnyStroke()) status.textContent = "渲染中…";
  }

  function hasAnyStroke() {
    return state.doc.layers.some((l) => l.strokes.length);
  }

  async function doRender() {
    const img = state.el.querySelector("#la-img");
    const status = state.el.querySelector("#la-status");
    if (!state.image || !img) return;
    if (!hasAnyStroke()) {
      img.src = state.image.file_url;
      status.textContent = "";
      renderLayerList();
      return;
    }
    const seq = ++state.renderSeq;
    try {
      const r = await Api.post("/api/local/render", {
        image_id: state.image.id, document: state.doc,
      });
      if (seq !== state.renderSeq) return; // 已有更新的请求
      img.src = `${r.file_url}?t=${Date.now()}`;
      status.textContent = r.cache_hit ? "缓存命中" : "已更新";
      renderLayerList(r.layers);
    } catch (e) {
      if (seq === state.renderSeq) status.textContent = "渲染失败：" + e.message;
    }
  }

  // ---------------------------------------------------------------- 提交
  async function commitImage() {
    if (!state.image) { C.toast("请先选择图像", "error"); return; }
    if (!hasAnyStroke()) { C.toast("还没有涂抹任何区域", "error"); return; }
    const btn = state.el.querySelector("#la-commit");
    btn.disabled = true;
    try {
      const r = await Api.post("/api/local/commit", {
        image_id: state.image.id, document: state.doc,
      });
      C.toast(`已保存为新图像：${r.image.filename}`, "success");
      const choice = C.modal(`
        <div style="font-size:13px;line-height:1.7">
          局部调整结果已保存到图像库（${r.image.width}×${r.image.height}）。
          可以在此结果上<strong>继续叠加</strong>其它局部/全局处理，或留在当前编辑。
        </div>
        <div class="modal-actions">
          <button class="btn" id="cm-stay">留在当前</button>
          <button class="btn btn-primary" id="cm-continue">以结果为底继续调整 →</button>
        </div>`, "导出成功");
      choice.el.querySelector("#cm-stay").onclick = choice.close;
      choice.el.querySelector("#cm-continue").onclick = () => {
        choice.close();
        C.refreshImages().then(() => {
          loadGallery(state.el);
          selectImage(r.image);
        });
      };
    } catch (e) {
      C.toast("导出失败：" + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- 工程存取
  async function saveDoc() {
    if (!state.image) { C.toast("请先选择图像", "error"); return; }
    const payload = {
      name: state.image.filename + " 的局部调整",
      image_id: state.image.id, source_type: "image", source_id: state.image.id,
      document: state.doc,
    };
    try {
      let r;
      if (state.docId) r = await Api.put(`/api/local/docs/${state.docId}`, { document: state.doc });
      else r = await Api.post("/api/local/docs", payload);
      state.docId = r.id;
      state.el.querySelector("#la-doc-name").textContent = `已保存工程：${r.name}`;
      C.toast("工程已保存", "success");
    } catch (e) { C.toast("保存失败：" + e.message, "error"); }
  }

  async function openDocMenu() {
    let docs = [];
    try { docs = (await Api.get("/api/local/docs")).docs; } catch (e) { /* ignore */ }
    const rows = docs.length ? docs.map((d) => `
      <div class="la-doc-row" data-did="${d.id}">
        <div><strong>${C.esc(d.name)}</strong></div>
        <div class="dim" style="font-size:11px">${C.fmtDate(d.updated_at)} · ${d.document.layers.length} 个图层</div>
      </div>`).join("") : `<div class="dim">暂无已保存工程</div>`;
    const m = C.modal(`<div style="max-height:50vh;overflow:auto">${rows}</div>`, "打开局部调整工程");
    m.el.querySelectorAll("[data-did]").forEach((row) => row.onclick = async () => {
      const d = docs.find((x) => x.id === row.dataset.did);
      m.close();
      await loadDocIntoSession(d);
    });
  }

  async function loadDocIntoSession(d) {
    const images = await C.refreshImages();
    let rec = images.find((im) => im.id === (d.source_id || d.image_id));
    if (!rec) { C.toast("底图已不存在，无法打开该工程", "error"); return; }
    state.image = rec;
    state.doc = d.document || { layers: [] };
    state.history = []; state.future = [];
    state.docId = d.id; state.masks = {};
    state.currentId = state.doc.layers.length ? state.doc.layers[state.doc.layers.length - 1].id : null;
    buildStage(rec);
    state.el.querySelector("#la-doc-name").textContent = `工程：${d.name}`;
    // 蒙版/面板在 buildStage 的 img.onload 中刷新；这里先更新图库选中态
    loadGallery(state.el, rec.id);
  }
})();
