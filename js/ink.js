/* ============================================================
   ink.js — 筆跡引擎：畫筆 / 螢光筆 / 橡皮擦 / 輪盤色盤
   ============================================================ */
(function (global) {
  'use strict';

  var PEN_COLORS = ['#2B2A28', '#E5686B', '#3D7BD6', '#3FA37B', '#E8912B'];
  var PEN_NAMES = ['黑', '紅', '藍', '綠', '橘'];
  var HL_COLORS = ['#FFE05C', '#7EE6A6', '#FF9CBB', '#7FC4FF', '#C3A6FF'];
  var HL_NAMES = ['黃', '綠', '粉', '藍', '紫'];
  var PEN_SIZES = [1, 1.5, 2, 3, 4.5, 7, 11, 16];
  var HL_SIZES = [10, 14, 20, 28, 38];

  var Ink = {
    mode: 'select',
    prevPen: null,             // Tab 用：上一支筆 {mode,colorIdx,size}
    /* 'auto'：看過觸控筆之後就只認觸控筆（手掌、手指不會畫到，也還能捲頁面）
       'finger'：手指也能畫，適合沒有觸控筆的裝置 */
    penOnly: localStorage.getItem('sn_penonly') || 'auto',
    sawPen: localStorage.getItem('sn_sawpen') === '1',
    tools: {
      pen: { colorIdx: 0, sizeIdx: 3, size: PEN_SIZES[3] },
      hl: { colorIdx: 0, sizeIdx: 2, size: HL_SIZES[2] },
      eraser: { size: 20 }
    },
    note: null,                // 由 app.js 指派
    history: [],
    redoStack: [],
    onChange: function () { },
    onToolChange: function () { },

    PEN_COLORS: PEN_COLORS, HL_COLORS: HL_COLORS,
    PEN_NAMES: PEN_NAMES, HL_NAMES: HL_NAMES
  };

  /* ---------- 目前筆的屬性 ---------- */
  function cur() {
    if (Ink.mode === 'hl') return Ink.tools.hl;
    if (Ink.mode === 'eraser') return Ink.tools.eraser;
    return Ink.tools.pen;   // pen / select 都用畫筆設定
  }
  Ink.curColor = function () {
    if (Ink.mode === 'hl') return HL_COLORS[Ink.tools.hl.colorIdx];
    return PEN_COLORS[Ink.tools.pen.colorIdx];
  };
  /* 現在該不該擋掉手指作畫？擋掉時手指就能捲動、縮放頁面 */
  Ink.fingerBlocked = function () {
    return Ink.penOnly === 'pen' || (Ink.penOnly === 'auto' && Ink.sawPen);
  };
  Ink.setPenOnly = function (m) {
    Ink.penOnly = m;
    localStorage.setItem('sn_penonly', m);
    Ink.onToolChange();
  };

  Ink.palette = function () { return Ink.mode === 'hl' ? HL_COLORS : PEN_COLORS; };
  Ink.paletteNames = function () { return Ink.mode === 'hl' ? HL_NAMES : PEN_NAMES; };
  Ink.curSize = function () { return cur().size; };

  function applyBodyClass(m) {
    var keep = document.body.className.split(/\s+/).filter(function (c) {
      return c && c.indexOf('mode-') !== 0;
    });
    keep.push('mode-' + m);
    if (m !== 'select') keep.push('mode-draw');
    document.body.className = keep.join(' ');
  }

  /* 進入畫筆模式時把文字游標放掉，否則單鍵快捷與 Ctrl+Z 會被文字編輯吃掉 */
  function dropCaret(m) {
    if (m === 'select') return;
    var a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) a.blur();
  }

  Ink.setMode = function (m, remember) {
    dropCaret(m);
    if (m === Ink.mode) return;
    if (remember !== false && (Ink.mode === 'pen' || Ink.mode === 'hl')) {
      Ink.prevPen = { mode: Ink.mode, colorIdx: cur().colorIdx, size: cur().size };
    }
    Ink.mode = m;
    applyBodyClass(m);
    Ink.onToolChange();
  };

  /* Tab：與上一支筆互換 */
  Ink.swapPen = function () {
    var now = { mode: Ink.mode, colorIdx: cur().colorIdx, size: cur().size };
    var p = Ink.prevPen;
    if (!p) { // 沒有記錄過就給個合理預設（黑筆 <-> 紅筆）
      p = { mode: 'pen', colorIdx: Ink.mode === 'pen' && Ink.tools.pen.colorIdx === 0 ? 1 : 0, size: Ink.tools.pen.size };
    }
    Ink.mode = p.mode;
    applyBodyClass(p.mode);
    var t = cur(); t.colorIdx = p.colorIdx; t.size = p.size;
    Ink.prevPen = (now.mode === 'pen' || now.mode === 'hl') ? now : null;
    Ink.onToolChange();
  };

  Ink.setColor = function (i) {
    if (Ink.mode === 'select' || Ink.mode === 'eraser') Ink.setMode('pen');
    cur().colorIdx = Math.max(0, Math.min(4, i));
    Ink.onToolChange();
  };

  Ink.stepSize = function (d) {
    var t = cur();
    if (Ink.mode === 'eraser') { t.size = Math.max(8, Math.min(90, t.size + d * 6)); Ink.onToolChange(); return; }
    var arr = Ink.mode === 'hl' ? HL_SIZES : PEN_SIZES;
    t.sizeIdx = Math.max(0, Math.min(arr.length - 1, (t.sizeIdx || 0) + d));
    t.size = arr[t.sizeIdx];
    Ink.onToolChange();
  };

  Ink.nudgeSize = function (d) {  // Ctrl+滾輪：無段
    var t = cur();
    var max = Ink.mode === 'hl' ? 60 : (Ink.mode === 'eraser' ? 90 : 30);
    t.size = Math.max(1, Math.min(max, +(t.size + d * (t.size < 4 ? .5 : 1.5)).toFixed(1)));
    Ink.onToolChange();
  };

  /* ---------- 座標換算 ---------- */
  function yAbs(block) { return block.type === 'text'; }

  function toLocal(block, px, py, w, h) {
    return [w ? px / w : 0, yAbs(block) ? py : (h ? py / h : 0)];
  }
  function toPx(block, x, y, w, h) {
    return [x * w, yAbs(block) ? y : y * h];
  }

  /* ---------- 繪製 ---------- */
  /**
   * @param startIdx 只從第幾段開始畫（畫筆專用）。
   *   畫筆是逐段畫的，補畫新的一段跟整條重畫結果一樣，
   *   所以寫字途中不必每次都把整塊畫布重來一遍。
   */
  function paintStroke(ctx, block, st, w, h, startIdx) {
    var pts = st.pts;
    if (!pts.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = st.color;

    if (st.tool === 'hl') {
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = st.size;
      ctx.beginPath();
      var p0 = toPx(block, pts[0][0], pts[0][1], w, h);
      ctx.moveTo(p0[0], p0[1]);
      for (var i = 1; i < pts.length; i++) {
        var p = toPx(block, pts[i][0], pts[i][1], w, h);
        ctx.lineTo(p[0], p[1]);
      }
      if (pts.length === 1) ctx.lineTo(p0[0] + .01, p0[1]);
      ctx.stroke();
    } else {
      // 有筆壓：逐段畫，寬度隨壓力變化
      for (var j = Math.max(1, startIdx || 1); j < pts.length; j++) {
        var a = toPx(block, pts[j - 1][0], pts[j - 1][1], w, h);
        var b = toPx(block, pts[j][0], pts[j][1], w, h);
        var pr = pts[j][2];
        if (!pr && pr !== 0) pr = .5;
        ctx.lineWidth = st.size * (0.55 + 0.9 * pr);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      if (pts.length === 1) {
        var c = toPx(block, pts[0][0], pts[0][1], w, h);
        ctx.fillStyle = st.color;
        ctx.beginPath();
        ctx.arc(c[0], c[1], st.size / 2, 0, 7);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  Ink.render = function (cv, block) {
    var rect = cv.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    (block.strokes || []).forEach(function (st) { paintStroke(ctx, block, st, w, h); });
    cv.__w = w; cv.__h = h;
  };

  /* ---------- 橡皮擦命中判定 ---------- */
  function hitStroke(block, st, x, y, w, h, r) {
    for (var i = 0; i < st.pts.length; i++) {
      var p = toPx(block, st.pts[i][0], st.pts[i][1], w, h);
      var dx = p[0] - x, dy = p[1] - y;
      if (dx * dx + dy * dy <= r * r) return true;
      if (i) {  // 線段中點也檢查，避免點距太疏漏判
        var q = toPx(block, st.pts[i - 1][0], st.pts[i - 1][1], w, h);
        var mx = (p[0] + q[0]) / 2 - x, my = (p[1] + q[1]) / 2 - y;
        if (mx * mx + my * my <= r * r) return true;
      }
    }
    return false;
  }

  /* ---------- 綁定畫布 ---------- */
  Ink.attach = function (cv, block) {
    /* 從資料庫還原回來的區塊若少了 strokes，第一筆 push 就會拋例外，
       畫面上看起來就是「這一塊不能畫」。 */
    if (!Array.isArray(block.strokes)) block.strokes = [];
    var drawing = false, curStroke = null, erased = null, pid = null;
    var pan = null;              // 手指捲動用（見 pointerdown 的說明）

    function pos(e) {
      var r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top, r.width, r.height];
    }

    cv.addEventListener('pointerdown', function (e) {
      if (Ink.mode === 'select') return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      /* 第一次看到觸控筆就記住：之後手指／手掌都不再畫，改成捲頁面。
         這裡不能 preventDefault，不然瀏覽器不會把手勢當成捲動。 */
      if (e.pointerType === 'pen' && !Ink.sawPen) {
        Ink.sawPen = true;
        localStorage.setItem('sn_sawpen', '1');
        Ink.onToolChange();
      }
      if (e.pointerType === 'touch' && Ink.fingerBlocked()) {
        /* 筆正在畫的時候手掌一定會壓在螢幕上，那時候絕不能當成捲動 ——
           不然畫面會在筆下面滑走。 */
        if (drawing) return;
        /* 手指不畫，改成捲動。畫布必須維持 touch-action:none —— 否則瀏覽器
           會連觸控筆的筆畫都當成捲動手勢攔走，所以捲動只能自己實作。 */
        var sc = cv.closest('#pagewrap');
        if (sc) {
          pan = { y: e.clientY, top: sc.scrollTop, el: sc, id: e.pointerId };
          try { cv.setPointerCapture(e.pointerId); } catch (err) { }
        }
        return;
      }
      /* 手掌先碰到螢幕、筆才落下的情況：把那個誤啟動的捲動取消掉 */
      pan = null;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId); pid = e.pointerId;
      var p = pos(e);
      drawing = true;

      if (Ink.mode === 'eraser') {
        erased = { kind: 'erase', blockId: block.id, items: [] };
        eraseAt(p);
      } else {
        var t = cur();
        curStroke = {
          tool: Ink.mode === 'hl' ? 'hl' : 'pen',
          color: Ink.curColor(),
          size: t.size,
          pts: [pt(p, e)]
        };
        block.strokes.push(curStroke);
        Ink.render(cv, block);
      }
    });

    function pt(p, e) {
      var l = toLocal(block, p[0], p[1], p[2], p[3]);
      var pr = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : .5;
      return [+l[0].toFixed(4), +l[1].toFixed(2), +pr.toFixed(2)];
    }

    function eraseAt(p) {
      var r = Ink.tools.eraser.size / 2;
      for (var i = block.strokes.length - 1; i >= 0; i--) {
        if (hitStroke(block, block.strokes[i], p[0], p[1], p[2], p[3], r)) {
          erased.items.push({ idx: i, stroke: block.strokes[i] });
          block.strokes.splice(i, 1);
        }
      }
      Ink.render(cv, block);
    }

    /* 螢光筆是一整條半透明路徑，逐段補畫會在接縫處疊出深色，
       只能整塊重畫 —— 但用 rAF 節流，一個影格最多一次。 */
    var rafId = 0;
    function scheduleFull() {
      if (rafId) return;
      rafId = requestAnimationFrame(function () { rafId = 0; Ink.render(cv, block); });
    }

    /* 畫筆：只補畫剛加進來的那幾段。
       原本每次移動都重畫全部筆跡，寫越多越頓（複雜度隨筆畫數線性成長）。 */
    function appendFrom(idx) {
      var w = cv.__w, h = cv.__h;
      if (!w || !h) { Ink.render(cv, block); return; }
      var ctx = cv.getContext('2d');
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintStroke(ctx, block, curStroke, w, h, idx);
    }

    cv.addEventListener('pointermove', function (e) {
      if (pan && e.pointerId === pan.id) {
        pan.el.scrollTop = pan.top - (e.clientY - pan.y);
        return;
      }
      if (!drawing || e.pointerId !== pid) return;
      e.preventDefault();

      if (Ink.mode === 'eraser') { eraseAt(pos(e)); return; }
      if (!curStroke) return;

      /* Apple Pencil 一個影格會取樣好幾次，但瀏覽器只把最後一點給你，
         中間的軌跡全丟掉，快速筆畫就變成一節一節的折線。
         getCoalescedEvents() 才拿得到那個影格裡的所有取樣點。 */
      /* 注意：getCoalescedEvents() 可能回傳空陣列，而空陣列是 truthy，
         用 `|| [e]` 接不住，會變成整筆只剩下按下去的那一個點。 */
      var evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      if (!evs.length) evs = [e];
      var r = cv.getBoundingClientRect();     // 一個影格量一次就好
      var from = curStroke.pts.length;

      for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        var p = [ev.clientX - r.left, ev.clientY - r.top, r.width, r.height];
        var last = curStroke.pts[curStroke.pts.length - 1];
        var lp = toPx(block, last[0], last[1], p[2], p[3]);
        if (Math.abs(lp[0] - p[0]) + Math.abs(lp[1] - p[1]) < 0.7) continue;
        curStroke.pts.push(pt(p, ev));
      }
      if (curStroke.pts.length === from) return;

      if (curStroke.tool === 'hl') scheduleFull();
      else appendFrom(from);
    });

    function finish(e) {
      if (pan && (!e || e.pointerId === pan.id)) pan = null;
      if (!drawing) return;
      /* 只有「正在畫的那一根」抬起才算畫完。
         少了這道檢查，手掌一抬起就會把筆正在畫的那一筆結束掉 ——
         手寫時手掌不斷接觸／離開螢幕，筆畫就被切得七零八落。 */
      if (e && pid !== null && e.pointerId !== pid) return;
      drawing = false; pid = null;
      if (Ink.mode === 'eraser') {
        if (erased && erased.items.length) pushHistory(erased);
        erased = null;
      } else if (curStroke) {
        if (curStroke.pts.length < 1) block.strokes.pop();
        else pushHistory({ kind: 'add', blockId: block.id, stroke: curStroke });
        curStroke = null;
      }
      Ink.onChange();
    }
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', finish);
    cv.addEventListener('pointerleave', function (e) { if (drawing) finish(e); });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  };

  /* ---------- 復原 / 重做 ---------- */
  function pushHistory(entry) {
    Ink.history.push(entry);
    if (Ink.history.length > 300) Ink.history.shift();
    Ink.redoStack.length = 0;      // 有新動作就不能再重做
  }

  /* 讓外部（例如「清除這塊筆跡」）也能登記成可復原的動作 */
  Ink.recordErase = function (blockId, strokes) {
    if (!strokes || !strokes.length) return;
    pushHistory({
      kind: 'erase',
      blockId: blockId,
      items: strokes.map(function (s, i) { return { idx: i, stroke: s }; }).reverse()
    });
  };

  Ink.canUndo = function () { return Ink.history.length > 0; };
  Ink.canRedo = function () { return Ink.redoStack.length > 0; };
  Ink.resetHistory = function () { Ink.history = []; Ink.redoStack = []; };

  Ink.undo = function (findBlock, rerender) {
    var h = Ink.history.pop();
    if (!h) return false;
    var b = findBlock(h.blockId);
    if (!b) return Ink.undo(findBlock, rerender);   // 區塊已刪除，跳過
    if (h.kind === 'add') {
      var i = b.strokes.indexOf(h.stroke);
      if (i >= 0) b.strokes.splice(i, 1);
    } else {
      h.items.slice().reverse().forEach(function (it) { b.strokes.splice(it.idx, 0, it.stroke); });
    }
    Ink.redoStack.push(h);
    rerender(b.id);
    Ink.onChange();
    return true;
  };

  Ink.redo = function (findBlock, rerender) {
    var h = Ink.redoStack.pop();
    if (!h) return false;
    var b = findBlock(h.blockId);
    if (!b) return Ink.redo(findBlock, rerender);
    if (h.kind === 'add') {
      if (b.strokes.indexOf(h.stroke) < 0) b.strokes.push(h.stroke);
    } else {
      h.items.forEach(function (it) {
        var i = b.strokes.indexOf(it.stroke);
        if (i >= 0) b.strokes.splice(i, 1);
      });
    }
    Ink.history.push(h);
    rerender(b.id);
    Ink.onChange();
    return true;
  };

  /* ============================================================
     輪盤色盤：按住空白鍵或滑鼠右鍵長按
     ============================================================ */
  var R = {
    el: null, cv: null, ctx: null, open: false, cx: 0, cy: 0, sel: -1,
    SIZE: 260, RIN: 44, ROUT: 118, N: 6
  };

  function radialInit() {
    if (R.el) return;
    R.el = document.getElementById('radial');
    R.cv = document.getElementById('radialCv');
    R.ctx = R.cv.getContext('2d');
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    R.cv.width = R.SIZE * dpr; R.cv.height = R.SIZE * dpr;
    R.cv.style.width = R.SIZE + 'px'; R.cv.style.height = R.SIZE + 'px';
    R.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function radialDraw() {
    var c = R.ctx, S = R.SIZE, m = S / 2;
    c.clearRect(0, 0, S, S);
    var cols = Ink.palette(), names = Ink.paletteNames();
    var step = Math.PI * 2 / R.N;
    for (var i = 0; i < R.N; i++) {
      var a0 = -Math.PI / 2 + i * step - step / 2;
      var a1 = a0 + step;
      var isEraser = (i === 5);
      var pad = 0.02;
      c.beginPath();
      c.arc(m, m, R.ROUT, a0 + pad, a1 - pad);
      c.arc(m, m, R.RIN, a1 - pad, a0 + pad, true);
      c.closePath();
      c.fillStyle = isEraser ? '#F0EBE3' : cols[i];
      c.globalAlpha = (R.sel === i) ? 1 : .82;
      c.fill();
      if (R.sel === i) {
        c.lineWidth = 3; c.strokeStyle = '#3B3A36'; c.globalAlpha = 1; c.stroke();
      }
      c.globalAlpha = 1;
      var am = (a0 + a1) / 2, rr = (R.RIN + R.ROUT) / 2;
      c.fillStyle = isEraser ? '#3B3A36' : '#ffffff';
      c.font = '700 15px "Microsoft JhengHei",sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(isEraser ? '擦' : names[i], m + Math.cos(am) * rr, m + Math.sin(am) * rr);
      c.font = '600 10px sans-serif';
      c.fillText(isEraser ? 'E' : String(i + 1), m + Math.cos(am) * (rr + 22), m + Math.sin(am) * (rr + 22));
    }
    // 中心
    c.beginPath(); c.arc(m, m, R.RIN - 4, 0, 7);
    c.fillStyle = '#fff'; c.fill();
    c.strokeStyle = '#EDE7DD'; c.lineWidth = 2; c.stroke();
    c.fillStyle = Ink.mode === 'eraser' ? '#8A8680' : Ink.curColor();
    c.beginPath(); c.arc(m, m - 5, Math.max(2, Math.min(15, Ink.curSize() / 2)), 0, 7); c.fill();
    c.fillStyle = '#8A8680'; c.font = '600 10px sans-serif';
    c.fillText(Ink.curSize() + ' px', m, m + 20);
  }

  Ink.radialOpen = function (x, y) {
    radialInit();
    if (R.open) return;
    R.open = true; R.sel = -1;
    R.cx = x; R.cy = y;
    R.el.style.left = (x - R.SIZE / 2) + 'px';
    R.el.style.top = (y - R.SIZE / 2) + 'px';
    R.el.hidden = false;
    radialDraw();
  };
  Ink.radialMove = function (x, y) {
    if (!R.open) return;
    var dx = x - R.cx, dy = y - R.cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < R.RIN * .6) { if (R.sel !== -1) { R.sel = -1; radialDraw(); } return; }
    var step = Math.PI * 2 / R.N;
    var a = Math.atan2(dy, dx) + Math.PI / 2 + step / 2;
    while (a < 0) a += Math.PI * 2;
    var i = Math.floor((a % (Math.PI * 2)) / step);
    if (i !== R.sel) { R.sel = i; radialDraw(); }
  };
  Ink.radialClose = function (apply) {
    if (!R.open) return;
    R.open = false; R.el.hidden = true;
    if (apply && R.sel >= 0) {
      if (R.sel === 5) Ink.setMode('eraser');
      else Ink.setColor(R.sel);
    }
    R.sel = -1;
  };
  Ink.radialIsOpen = function () { return R.open; };

  global.Ink = Ink;
})(window);
