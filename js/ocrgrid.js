/* ============================================================
   ocrgrid.js — 照圖上「畫出來的線」還原表格，包含合併儲存格（rowspan/colspan）

   app.js 原本的表格還原是看文字的位置猜欄、猜列，一格跨好幾列
   （左邊兩列對一格「+ V-ing」、右邊整欄只有一格「+ 主詞」）這種線畫得
   不對稱的表格，猜不出來：整個內文會被當成同一列。
   這裡改成先把圖上的線找出來（包含虛線、淡色細線、標題色塊裡留白的縫），
   線與線圍出來的方格就是「最小格」；兩個相鄰的最小格中間沒有線擋著，
   就是同一個合併儲存格。再把每一段 OCR 文字放進它所在的格子。

   寧可不處理也不要弄錯：線的結構湊不成整齊的矩形、有文字壓在分隔線上、
   或是整張表根本沒有合併儲存格，都回傳 null，由 app.js 原本的做法接手。
   ============================================================ */
(function (global) {
  'use strict';

  var OcrGrid = {};

  /* ---------------- 1. 找線 ---------------- */

  /** 灰階亮度。透明的地方當成白底，不然會被當成黑色。 */
  function luminance(cv) {
    var w = cv.width, h = cv.height, d;
    try { d = cv.getContext('2d').getImageData(0, 0, w, h).data; } catch (e) { return null; }
    var L = new Uint8Array(w * h);
    for (var i = 0, n = 0; n < L.length; i += 4, n++) {
      var a = d[i + 3] / 255;
      var v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      L[n] = Math.round(v * a + 255 * (1 - a));
    }
    return L;
  }

  /**
   * 找圖上的細線（橫的或直的），含虛線。
   * 判斷每個點：這個點跟它兩側 D 個像素外的點「都明顯不同、而且兩側彼此相近」
   * —— 白底上的細線（深或淡都行）、有色底上留白的縫，都符合；
   * 文字的直筆畫兩側不會都是空白，不會被當成線。
   * 再沿線的方向把點接成一段（容許虛線的空隙），夠長、夠密才算。
   * @return [{ p, t1, t2 }] p 是線的位置（橫線是 y、直線是 x），t1~t2 是延伸的範圍
   */
  function findThin(L, w, h, vertical, textH, boxes) {
    var LEN = vertical ? h : w, CNT = vertical ? w : h;
    var D = 4, T = 24, GAP = 5;
    var at = vertical ? function (a, b) { return L[b * w + a]; } : function (a, b) { return L[a * w + b]; };
    var minRun = 16;
    var runs = [];
    for (var a = D; a < CNT - D; a++) {
      var start = -1, last = -1, ink = 0;
      for (var b = 0; b <= LEN; b++) {
        var on = false;
        if (b < LEN) {
          var c = at(a, b), n1 = at(a - D, b), n2 = at(a + D, b);
          on = Math.abs(c - n1) > T && Math.abs(c - n2) > T && Math.abs(n1 - n2) <= T &&
            ((c < n1 && c < n2) || (c > n1 && c > n2));
        }
        if (on) {
          if (start < 0) { start = b; ink = 0; }
          last = b; ink++;
        } else if (start >= 0 && (b - last > GAP || b === LEN)) {
          if (last - start + 1 >= minRun && ink >= (last - start + 1) * 0.5) runs.push({ p: a, t1: start, t2: last });
          start = -1;
        }
      }
    }
    if (!runs.length) return [];

    /* 同一條線在相鄰幾行都會出現，接成一塊；太厚的不是細線（是文字或色塊） */
    var blocks = [];
    runs.forEach(function (r) {
      for (var i = 0; i < blocks.length; i++) {
        var bk = blocks[i];
        if (r.p - bk.p2 <= 1 && r.t1 <= bk.t2 && r.t2 >= bk.t1) {
          bk.p2 = r.p; bk.t1 = Math.min(bk.t1, r.t1); bk.t2 = Math.max(bk.t2, r.t2);
          return;
        }
      }
      blocks.push({ p1: r.p, p2: r.p, t1: r.t1, t2: r.t2 });
    });
    blocks = blocks.filter(function (bk) { return bk.p2 - bk.p1 + 1 <= 4; })
      .map(function (bk) { return { p: (bk.p1 + bk.p2) / 2, t1: bk.t1, t2: bk.t2 }; });

    /* 同一條線被切成幾段（標題色塊裡的縫接著底下的虛線）要接回去 */
    var joinGap = Math.max(8, Math.round(textH * 0.4));
    blocks.sort(function (x, y) { return (x.p - y.p) || (x.t1 - y.t1); });
    var lines = [];
    blocks.forEach(function (bk) {
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (Math.abs(ln.p - bk.p) <= 3 && bk.t1 <= ln.t2 + joinGap && bk.t2 >= ln.t1 - joinGap) {
          ln.t1 = Math.min(ln.t1, bk.t1); ln.t2 = Math.max(ln.t2, bk.t2);
          return;
        }
      }
      lines.push({ p: bk.p, t1: bk.t1, t2: bk.t2 });
    });

    var minSeg = Math.max(40, Math.round(textH * 2));
    return lines.filter(function (ln) {
      if (ln.t2 - ln.t1 + 1 < minSeg) return false;
      /* 壓在文字中間的「線」其實是文字的筆畫（一連串字的橫筆畫剛好同高）。
         真正的分隔線在文字行與行之間，不會有一大段落在字框裡面。 */
      var inside = 0;
      boxes.forEach(function (bx) {
        var lo = vertical ? bx.l + (bx.r - bx.l) * 0.2 : bx.t + (bx.b - bx.t) * 0.2;
        var hi = vertical ? bx.r - (bx.r - bx.l) * 0.2 : bx.b - (bx.b - bx.t) * 0.2;
        if (ln.p <= lo || ln.p >= hi) return;
        var t1 = vertical ? bx.t : bx.l, t2 = vertical ? bx.b : bx.r;
        inside += Math.max(0, Math.min(ln.t2, t2) - Math.max(ln.t1, t1));
      });
      return inside < (ln.t2 - ln.t1) * 0.25;
    });
  }

  /* ---------------- 2. 線 -> 格線座標 ---------------- */

  /** 把位置接近的線併成一條格線，記下它在各處延伸的範圍 */
  function clusterLines(segs, tol) {
    segs = segs.slice().sort(function (a, b) { return a.p - b.p; });
    var out = [];
    segs.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s.p - last.pos <= tol) {
        last.spans.push([s.t1, s.t2]);
        last.pos = (last.pos * (last.spans.length - 1) + s.p) / last.spans.length;
        last.real = last.real || !!s.real;
        return;
      }
      out.push({ pos: s.p, spans: [[s.t1, s.t2]], real: !!s.real });
    });
    return out;
  }

  /** 這條格線在 [a, b] 這一段，有幾成被畫了線 */
  function coverage(line, a, b) {
    if (b <= a) return 0;
    var sp = line.spans.map(function (s) { return [Math.max(a, s[0]), Math.min(b, s[1])]; })
      .filter(function (s) { return s[1] > s[0]; }).sort(function (x, y) { return x[0] - y[0]; });
    var got = 0, end = a;
    sp.forEach(function (s) {
      var from = Math.max(s[0], end);
      if (s[1] > from) { got += s[1] - from; end = s[1]; }
    });
    return got / (b - a);
  }

  /* ---------------- 3. 主程式 ---------------- */

  /* 診斷用：最後一次沒走這條路的原因編號、找到的格線（在主控台看 OcrGrid.why / OcrGrid.dbg） */
  var fail = function (n) { OcrGrid.why = n; return null; };

  var SEP = 0.6;    // 一條線在某一段畫了幾成以上，就算把兩邊隔開

  /**
   * 用一組線排出格子。
   * @return null（放棄，原因記在 OcrGrid.why）
   *       | { split: [線] }  有的格子裡其實是好幾欄的字（圖上沒畫線隔開），補幾條線再排一次
   *       | { nc, rows }
   */
  function layout(items, textH, hSegs, vSegs) {
    var xl = Math.min.apply(null, items.map(function (it) { return it.l; }));
    var xr = Math.max.apply(null, items.map(function (it) { return it.r; }));
    var yt = Math.min.apply(null, items.map(function (it) { return it.t0; }));
    var yb = Math.max.apply(null, items.map(function (it) { return it.b; }));
    /* 表格的範圍：文字加上線的範圍 */
    hSegs.forEach(function (s) { yt = Math.min(yt, s.p); yb = Math.max(yb, s.p); });
    vSegs.forEach(function (s) { xl = Math.min(xl, s.p); xr = Math.max(xr, s.p); });
    var edgeTol = Math.max(4, textH * 0.3);

    var tol = Math.max(3, textH * 0.12);
    var hLines = clusterLines(hSegs, tol), vLines = clusterLines(vSegs, tol);
    /* 在最外緣的線是表格的邊框，不是裡面的分隔 */
    hLines = hLines.filter(function (ln) { return ln.pos > yt + edgeTol && ln.pos < yb - edgeTol; });
    vLines = vLines.filter(function (ln) { return ln.pos > xl + edgeTol && ln.pos < xr - edgeTol; });
    OcrGrid.dbg = {
      h: hLines.map(function (l) { return [Math.round(l.pos), l.spans]; }),
      v: vLines.map(function (l) { return [Math.round(l.pos), l.spans, l.real]; }), textH: textH
    };
    if (!hLines.length && !vLines.length) return fail(5);

    var ys = [yt].concat(hLines.map(function (ln) { return ln.pos; })).concat([yb]);
    var xs = [xl].concat(vLines.map(function (ln) { return ln.pos; })).concat([xr]);
    var nr = ys.length - 1, nc = xs.length - 1;
    if (nr * nc > 400) return fail(6);

    /* 文字不能被分隔線切開（一行文字的框跨過一條畫著的線）：
       線的位置對不上文字的話，後面的歸格會錯，直接放棄 */
    var q;
    for (var ii = 0; ii < items.length; ii++) {
      var it = items[ii], ih = it.b - it.t0;
      for (q = 0; q < vLines.length; q++) {
        var vx = vLines[q].pos;
        if (vx > it.l + ih * 0.3 && vx < it.r - ih * 0.3 && coverage(vLines[q], it.t0, it.b) >= SEP) return fail(7);
      }
      for (q = 0; q < hLines.length; q++) {
        var hy = hLines[q].pos;
        if (hy > it.t0 + ih * 0.3 && hy < it.b - ih * 0.3 && coverage(hLines[q], it.l, it.r) >= SEP) return fail(8);
      }
    }

    /* 相鄰兩個最小格中間沒有線擋著，就併成同一格 */
    var parent = [], k;
    for (k = 0; k < nr * nc; k++) parent.push(k);
    var find = function (x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    var join = function (a, b) { parent[find(a)] = find(b); };
    var r, c;
    for (r = 0; r < nr; r++) {
      for (c = 0; c < nc; c++) {
        if (c + 1 < nc && coverage(vLines[c], ys[r], ys[r + 1]) < SEP) join(r * nc + c, r * nc + c + 1);
        if (r + 1 < nr && coverage(hLines[r], xs[c], xs[c + 1]) < SEP) join(r * nc + c, (r + 1) * nc + c);
      }
    }
    /* 每一個併起來的格子都要是整齊的矩形，不然代表線沒抓準，放棄 */
    var comps = {};
    for (r = 0; r < nr; r++) {
      for (c = 0; c < nc; c++) {
        var id = find(r * nc + c), cm = comps[id];
        if (!cm) cm = comps[id] = { r0: r, r1: r, c0: c, c1: c, n: 0 };
        cm.r0 = Math.min(cm.r0, r); cm.r1 = Math.max(cm.r1, r);
        cm.c0 = Math.min(cm.c0, c); cm.c1 = Math.max(cm.c1, c);
        cm.n++;
      }
    }
    var list = Object.keys(comps).map(function (key) { return comps[key]; });
    for (k = 0; k < list.length; k++) {
      var cp = list[k];
      if (cp.n !== (cp.r1 - cp.r0 + 1) * (cp.c1 - cp.c0 + 1)) return fail(9);
    }

    /* 文字放進所在的格子（用框的中心判斷） */
    var which = function (arr, v) {
      var n = 0;
      for (var i = 1; i < arr.length - 1; i++) if (v >= arr[i]) n = i;
      return n;
    };
    items.forEach(function (it2) {
      var rr = which(ys, (it2.t0 + it2.b) / 2), cc = which(xs, (it2.l + it2.r) / 2);
      var cp2 = comps[find(rr * nc + cc)];
      (cp2.items || (cp2.items = [])).push(it2);
    });

    /* 每一格裡：依垂直位置排，高度差不到半個字的算同一行，由左到右接起來 */
    var cands = [], gaps = [];
    list.forEach(function (cp3) {
      cp3.items = cp3.items || [];
      cp3.items.sort(function (a, b) { return ((a.t0 + a.b) / 2 - (b.t0 + b.b) / 2) || (a.l - b.l); });
      var lines = [];
      cp3.items.forEach(function (it3) {
        var ln = lines[lines.length - 1], mid = (it3.t0 + it3.b) / 2;
        if (ln && Math.abs(ln.mid - mid) <= Math.max(ln.h, it3.b - it3.t0) * 0.5) {
          ln.parts.push(it3);
          ln.top = Math.min(ln.top, it3.t0); ln.bot = Math.max(ln.bot, it3.b);
          return;
        }
        lines.push({ mid: mid, h: it3.b - it3.t0, parts: [it3], top: it3.t0, bot: it3.b });
      });
      cp3.lines = lines;
      lines.forEach(function (ln2, li) {
        ln2.parts.sort(function (a, b) { return a.l - b.l; });
        /* 同一行裡兩段字隔得很開 = 其實是兩欄，只是圖上沒畫線隔開
           （英文例句和它的中文翻譯、單字和它的詞性）。在右邊那段的左緣補一條線 */
        for (var pi = 1; pi < ln2.parts.length; pi++) {
          if (ln2.parts[pi].l - ln2.parts[pi - 1].r > textH * 1.5) {
            cands.push({ p: ln2.parts[pi].l - textH * 0.5, t1: ys[cp3.r0], t2: ys[cp3.r1 + 1], cp: cp3 });
          }
        }
        if (li) gaps.push(ln2.top - lines[li - 1].bot);
      });
    });
    /* 補線要有佐證才算：同一個位置在兩個以上的格子都有（整欄對齊），或是旁邊
       本來就畫了一條線（只是這一段沒畫到）。單一格子裡的字隔得開（-ium  -um）
       常常只是排版，硬切會多出一欄。 */
    /* 跨欄的格子裡，字分別落在一條畫出來的直線的左右兩邊（標題色塊裡「單字」
       「字尾」之間沒有縫，下面的表格卻有一條線）：那條線本來就該一路畫上來，補上 */
    var through = [];
    list.forEach(function (cp7) {
      if (cp7.c1 === cp7.c0) return;
      for (var bi = cp7.c0; bi < cp7.c1; bi++) {
        var vl = vLines[bi];
        if (!vl.real) continue;
        var leftSide = false, rightSide = false;
        cp7.items.forEach(function (it4) {
          if (it4.r <= vl.pos) leftSide = true;
          if (it4.l >= vl.pos) rightSide = true;
        });
        if (leftSide && rightSide) through.push({ p: vl.pos, t1: ys[cp7.r0], t2: ys[cp7.r1 + 1], real: true });
      }
    });
    if (through.length) return { split: through };

    if (cands.length) {
      cands.sort(function (a, b) { return a.p - b.p; });
      var groups = [], grp = null;
      cands.forEach(function (cd) {
        if (grp && cd.p - grp.min <= textH * 2) { grp.items.push(cd); return; }
        grp = { min: cd.p, items: [cd] };
        groups.push(grp);
      });
      var splits = [];
      groups.forEach(function (g) {
        var comps2 = [];
        g.items.forEach(function (cd) { if (comps2.indexOf(cd.cp) < 0) comps2.push(cd.cp); });
        var near = null;
        vLines.forEach(function (ln) { if (ln.real && Math.abs(ln.pos - g.min) <= textH * 0.8) near = ln; });
        if (comps2.length + (near ? 2 : 0) < 2) return;
        g.items.forEach(function (cd) {
          splits.push({ p: near ? near.pos : g.min, t1: cd.t1, t2: cd.t2, real: false });
        });
      });
      if (splits.length) return { split: splits };
    }

    /* 同一格裡行與行之間突然隔得特別開 = 其實是上下兩列，只是圖上沒畫線隔開。
       這種情況靠線分不出來，交給文字位置的做法 */
    if (gaps.length >= 3) {
      var sg = gaps.slice().sort(function (a, b) { return a - b; });
      var med = sg[Math.floor(sg.length / 2)];
      var big = Math.max(med * 1.8, textH * 0.5);
      for (k = 0; k < gaps.length; k++) if (gaps[k] > big) return fail(13);
    }

    /* 只有「真的有合併」才值得走這條路；規規矩矩的格子（或只有橫貫整張表的標題）
       用 app.js 原本的做法。沒有任何格子「從這一列／欄開始」的列、欄，只是
       多切出來的，併進前一個。 */
    var rowStart = [], colStart = [];
    for (r = 0; r < nr; r++) rowStart.push(false);
    for (c = 0; c < nc; c++) colStart.push(false);
    list.forEach(function (cp4) { rowStart[cp4.r0] = true; colStart[cp4.c0] = true; });
    var rowIdx = [], colIdx = [], nRows = 0, nCols = 0;
    for (r = 0; r < nr; r++) { rowIdx.push(nRows); if (rowStart[r]) nRows++; }
    for (c = 0; c < nc; c++) { colIdx.push(nCols); if (colStart[c]) nCols++; }
    var cntRows = function (r0, r1) { var n = 0; for (var i = r0; i <= r1; i++) if (rowStart[i]) n++; return n; };
    var cntCols = function (c0, c1) { var n = 0; for (var i = c0; i <= c1; i++) if (colStart[i]) n++; return n; };
    if (nRows < 2 || nCols < 2) return fail(14);

    /* 「跨欄」要有真的畫出來的直線當證據；只靠補的線不算 */
    var merged = false;
    list.forEach(function (cp5) {
      if (cntRows(cp5.r0, cp5.r1) > 1) merged = true;
      if (cntCols(cp5.c0, cp5.c1) > 1 && cntCols(cp5.c0, cp5.c1) < nCols) {
        for (var bi = cp5.c0; bi < cp5.c1; bi++) if (vLines[bi].real) merged = true;
      }
    });
    if (!merged) return fail(10);

    var rows = [];
    for (r = 0; r < nRows; r++) rows.push([]);
    list.forEach(function (cp6) {
      var cellRight = xs[cp6.c1 + 1];
      var text = '', prevLine = null;
      cp6.lines.forEach(function (ln3) {
        ln3.t = ln3.parts.map(function (p) { return p.t; }).join(' ');
        ln3.right = ln3.parts[ln3.parts.length - 1].r;
        if (prevLine) {
          /* 上一行幾乎貼到格子右邊、這一行又是小寫開頭 = 同一句被折行，用空白接；
             其他情況（中英文各一行、一行一個字）另起一行 */
          var wrapped = prevLine.right >= cellRight - textH * 2.5 &&
            /^[a-z0-9,.;:)]/.test(ln3.t) && !/[)）。.!?！？」』]\s*$/.test(prevLine.t);
          text += (wrapped ? ' ' : String.fromCharCode(0x2028));
        }
        text += ln3.t;
        prevLine = ln3;
      });
      rows[rowIdx[cp6.r0]].push({
        c: colIdx[cp6.c0], rs: cntRows(cp6.r0, cp6.r1), cs: cntCols(cp6.c0, cp6.c1), t: text
      });
    });
    rows.forEach(function (row) { row.sort(function (a, b) { return a.c - b.c; }); });

    var any = false;
    rows.forEach(function (row) { row.forEach(function (cl) { if (cl.t) any = true; }); });
    if (!any) return fail(11);
    return { nc: nCols, rows: rows };
  }

  /**
   * @param o.lines  OCR 的行（放大 f 倍的座標），要先濾掉格線被誤讀的雜字
   * @param o.src    原始解析度的圖（canvas）
   * @param o.f      OCR 座標相對原圖的倍率
   * @param o.rulesH app.js 的 findRules 結果（座標也放大 f 倍），只用到標題色塊的上下緣
   * @return null | { nc, rows: [[{ c, rs, cs, t }]] }  t 裡的 U+2028 是格內換行
   */
  OcrGrid.build = function (o) {
    OcrGrid.why = null;
    var f = o.f || 1, src = o.src;
    var w = src.width, h = src.height;
    var items = (o.lines || []).filter(function (l) { return l && String(l.t || '').trim() && l.h > 0; })
      .map(function (l) {
        return { t: String(l.t).trim(), l: l.x / f, r: (l.x + l.w) / f, t0: l.y / f, b: (l.y + l.h) / f };
      });
    if (items.length < 3) return fail(1);
    var boxes = items.map(function (it) { return { l: it.l, r: it.r, t: it.t0, b: it.b }; });
    var hs = items.map(function (it) { return it.b - it.t0; }).sort(function (a, b) { return a - b; });
    var textH = hs[Math.floor(hs.length / 2)];
    if (!(textH >= 6)) return fail(2);

    var L = luminance(src);
    if (!L) return fail(3);
    var mark = function (s) { s.real = true; return s; };
    var hSegs = findThin(L, w, h, false, textH, boxes).map(mark);
    var vSegs = findThin(L, w, h, true, textH, boxes).map(mark);
    /* 標題色塊那種太厚、細線偵測抓不到的，借 app.js 的 findRules：它回報的是
       色塊的上下緣（y1 != y2）。細線它也抓得到，但它不會說線從哪裡到哪裡，
       拿來當整條橫貫的線會把「只畫了一半的線」誤當成整條，所以細線用自己找的。 */
    (o.rulesH || []).forEach(function (r) {
      if (r.y2 - r.y1 <= 3 * f) return;
      hSegs.push({ p: r.y1 / f, t1: 0, t2: w, real: true });
      hSegs.push({ p: r.y2 / f, t1: 0, t2: w, real: true });
    });
    if (!hSegs.length && !vSegs.length) return fail(4);

    /* 有的格子裡其實是好幾欄的字：補線之後重排，最多補幾輪 */
    var extra = [];
    for (var attempt = 0; attempt < 5; attempt++) {
      var res = layout(items, textH, hSegs, vSegs.concat(extra));
      if (res && res.split) { extra = extra.concat(res.split); continue; }
      return res;
    }
    return fail(12);
  };

  global.OcrGrid = OcrGrid;
})(window);
