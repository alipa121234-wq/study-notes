/* ============================================================
   editor.js — 文字區塊的選取標記（螢光筆 / 字色）與語音插入
   ============================================================ */
(function (global) {
  'use strict';

  var Editor = {};

  function editableRoot(node) {
    while (node && node !== document.body) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('content') &&
        node.getAttribute('contenteditable') === 'true') return node;
      node = node.parentNode;
    }
    return null;
  }

  Editor.currentRoot = function () {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount) return null;
    return editableRoot(sel.getRangeAt(0).startContainer);
  };

  Editor.selectionText = function () {
    var sel = global.getSelection();
    return sel && sel.rangeCount ? sel.toString() : '';
  };

  /* ---------- 取出 range 內的文字節點，並在邊界切開 ---------- */
  /* 會先把選取範圍兩端的空白／換行修掉，避免螢光筆連換行一起包進去 */
  function textNodesInRange(range, root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.length) continue;
      if (range.intersectsNode(n)) out.push(n);
    }

    var picked = [];
    out.forEach(function (n) {
      var s = (n === range.startContainer) ? range.startOffset : 0;
      var e = (n === range.endContainer) ? range.endOffset : n.nodeValue.length;
      if (e <= s) return;
      picked.push({ node: n, s: s, e: e });
    });

    /* 兩端整段都是空白的節點丟掉，再切掉首尾節點的前後空白 */
    function blank(p) { return !p.node.nodeValue.slice(p.s, p.e).trim(); }
    while (picked.length && blank(picked[0])) picked.shift();
    while (picked.length && blank(picked[picked.length - 1])) picked.pop();
    if (picked.length) {
      var f = picked[0], fv = f.node.nodeValue.slice(f.s, f.e);
      f.s += fv.length - fv.replace(/^\s+/, '').length;
      var l = picked[picked.length - 1], lv = l.node.nodeValue.slice(l.s, l.e);
      l.e -= lv.length - lv.replace(/\s+$/, '').length;
    }

    var res = [];
    picked.forEach(function (p) {
      var node = p.node;
      if (p.e < node.nodeValue.length) node.splitText(p.e);
      if (p.s > 0) node = node.splitText(p.s);
      res.push(node);
    });
    return res;
  }

  /* ---------- 把文字節點從 inline 祖先中「獨立」出來 ---------- */
  /* 只能穿過 inline 元素。碰到 <div>/<p>/<li> 這種區塊元素一定要停下來，
     否則會把整行的 <div> 從中間剖成兩個，畫面上就多出一行，
     而且螢光筆的 <span> 會包住區塊元素，變成一條細長條而不是蓋在字上面。 */
  var INLINE_TAGS = /^(SPAN|B|I|U|S|EM|STRONG|MARK|SMALL|SUB|SUP|FONT|A|CODE|ABBR|LABEL)$/;

  function isolate(textNode, root) {
    var node = textNode, parent = node.parentNode;
    while (parent && parent !== root && parent.nodeType === 1 &&
      INLINE_TAGS.test(parent.tagName)) {
      if (node.previousSibling) {
        var left = parent.cloneNode(false);
        while (parent.firstChild && parent.firstChild !== node) left.appendChild(parent.firstChild);
        parent.parentNode.insertBefore(left, parent);
      }
      if (node.nextSibling) {
        var right = parent.cloneNode(false);
        while (node.nextSibling) right.appendChild(node.nextSibling);
        parent.parentNode.insertBefore(right, parent.nextSibling);
      }
      node = parent;
      parent = parent.parentNode;
    }
    return node;
  }

  function stripKind(el, kind) {
    /* kind 只會是程式裡寫死的 hl（螢光筆）／fc（字色）／fs（字級） */
    var re = new RegExp('^' + kind + '(-\\d)?$');
    var list = [el].concat(el.nodeType === 1 ? Array.prototype.slice.call(el.querySelectorAll('*')) : []);
    list.forEach(function (e) {
      if (e.nodeType !== 1 || !e.classList) return;
      Array.prototype.slice.call(e.classList).forEach(function (c) { if (re.test(c)) e.classList.remove(c); });
      if (e.tagName === 'SPAN' && !e.className) unwrap(e);
    });
  }

  function unwrap(el) {
    var p = el.parentNode;
    if (!p) return;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
  }

  function cleanup(root) {
    Array.prototype.slice.call(root.querySelectorAll('span')).forEach(function (s) {
      if (!s.textContent.length && !s.querySelector('br,img')) s.parentNode && s.parentNode.removeChild(s);
      else if (!s.className) unwrap(s);
    });
    root.normalize();
  }

  /**
   * 套用標記
   * @param kind 'hl' 螢光筆 | 'fc' 字色
   * @param idx  1~5 ；0 = 清除該類標記
   */
  Editor.mark = function (kind, idx) {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    var range = sel.getRangeAt(0);
    var root = editableRoot(range.startContainer);
    if (!root) return false;

    var nodes = textNodesInRange(range, root);
    if (!nodes.length) return false;

    var wrapped = [];
    nodes.forEach(function (tn) {
      var top = isolate(tn, root);
      if (top.nodeType === 1) {
        stripKind(top, kind);
        // 舊標記被剝乾淨時 stripKind 會把整個 span 拆掉，top 就脫離 DOM 了，
        // 這時要改用文字節點本身，否則 insertBefore 會炸掉（換色會失敗）
        if (!top.parentNode) top = tn;
      }
      if (!top.parentNode) return;
      if (!idx) { wrapped.push(top); return; }
      var span = document.createElement('span');
      span.className = kind + ' ' + kind + '-' + idx;
      top.parentNode.insertBefore(span, top);
      span.appendChild(top);
      wrapped.push(span);
    });
    if (!wrapped.length) return false;

    cleanup(root);

    // 重新選回原本範圍
    try {
      var r = document.createRange();
      var first = wrapped[0], last = wrapped[wrapped.length - 1];
      if (first.parentNode && last.parentNode) {
        r.setStartBefore(first); r.setEndAfter(last);
        sel.removeAllRanges(); sel.addRange(r);
      }
    } catch (e) { /* ignore */ }
    return true;
  };

  /* ---------- 字級 ----------
     小／正常／大／更大／特大 五段。「正常」不包任何標籤，
     其他各段對應 fs-1 ~ fs-4（fs-1 是「小」）。
     跟螢光筆一樣走 Editor.mark，所以巢狀、切割、清除的規則都一致；
     出考題只認 .hl，字級不會影響題目。 */
  var SIZE_CLASS = [1, 0, 2, 3, 4];
  var SIZE_NAME = ['小', '正常', '大', '更大', '特大'];
  function sizeLevelOf(node, root) {
    var el = node && node.nodeType === 3 ? node.parentNode : node;
    while (el && el !== root) {
      if (el.classList && el.classList.contains('fs')) {
        var m = el.className.match(/\bfs-(\d)\b/);
        var k = m ? SIZE_CLASS.indexOf(+m[1]) : -1;
        if (k >= 0) return k;
      }
      el = el.parentNode;
    }
    return 1;
  }
  /**
   * 選取的字變大（delta=1）或變小（delta=-1）一段。
   * 以選取開頭那個字目前的大小為準，整段套成同一個大小。
   * @return null（沒有選取）或 { level, name, same }
   */
  Editor.stepSize = function (delta) {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var root = editableRoot(range.startContainer);
    if (!root) return null;
    var first = null, sc = range.startContainer;
    if (sc.nodeType === 3 && range.startOffset < sc.nodeValue.length && sc.nodeValue.slice(range.startOffset).trim()) {
      first = sc;
    } else {
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n;
      while ((n = w.nextNode())) {
        if (range.intersectsNode(n) && n.nodeValue.trim() &&
          !(n === sc && range.startOffset >= n.nodeValue.length)) { first = n; break; }
      }
    }
    if (!first) return null;
    var cur = sizeLevelOf(first, root);
    var next = Math.max(0, Math.min(SIZE_NAME.length - 1, cur + delta));
    if (next === cur) return { level: cur, name: SIZE_NAME[cur], same: true };
    if (!Editor.mark('fs', SIZE_CLASS[next])) return null;
    return { level: next, name: SIZE_NAME[next], same: false };
  };

  Editor.clearMarks = function () {
    var ok1 = Editor.mark('hl', 0);
    var ok2 = Editor.mark('fc', 0);
    return ok1 || ok2;
  };

  /**
   * 讓螢光筆／字色的標記「不會愈長愈長」。
   * contenteditable 的預設行為是：游標停在 <span> 尾端時，接著打的字會落在
   * span 裡面 —— 於是標了一次顏色之後，後面打的字全部被塗上同一個顏色。
   */
  Editor.keepMarksClosed = function () {
    function markAt(node, root) {
      var el = node && node.nodeType === 3 ? node.parentNode : node;
      while (el && el !== root) {
        if (el.classList && (el.classList.contains('hl') || el.classList.contains('fc'))) return el;
        el = el.parentNode;
      }
      return null;
    }
    /* 游標是不是剛好停在這個標記的最尾端（後面沒有任何內容了） */
    function atEnd(el, node, offset) {
      if (node.nodeType === 3) { if (offset !== node.nodeValue.length) return false; }
      else if (offset !== node.childNodes.length) return false;
      var n = node;
      while (n && n !== el) { if (n.nextSibling) return false; n = n.parentNode; }
      return n === el;
    }
    /* 光把游標移到標記外面沒有用 —— 瀏覽器會把「游標前面那個行內元素」的
       樣式繼承給新輸入的字，字還是會被塞回標記裡。
       所以改成事後檢查：先記住標記原本多長，輸入完若變長，就把多出來的
       那幾個字搬到標記外面。這樣不必為鍵盤、注音、手寫轉文字、貼上、語音
       各寫一套攔截，任何一種輸入方式都攔得到。 */
    var watch = null;        // { el: 標記, len: 輸入前的長度 }
    var composing = false;

    function noteCaret() {
      /* 組字（注音、拼音…）進行中不要重記。組字時游標會一直動，
         再記一次就會把「已經變長」的長度當成原本的長度，
         結算時差值變成 0，等於整個修正失效。 */
      if (composing) return;
      var root = Editor.currentRoot();
      var sel = global.getSelection();
      if (!root || !sel || !sel.rangeCount || !sel.isCollapsed) { watch = null; return; }
      var r = sel.getRangeAt(0);
      if (!root.contains(r.startContainer)) { watch = null; return; }
      var m = markAt(r.startContainer, root);
      watch = (m && atEnd(m, r.startContainer, r.startOffset))
        ? { el: m, len: m.textContent.length } : null;
    }

    function pullOut(w) {
      w = w || watch;
      if (composing || !w) return;
      var m = w.el, before = w.len;
      watch = null;
      if (!m.parentNode) return;
      var extra = m.textContent.length - before;
      if (extra <= 0) return;

      /* 只處理「文字直接放在標記底下」這個常見情況；
         巢狀結構就不動，寧可少做也不要把內容搬錯位置。 */
      var last = m.lastChild;
      if (!last || last.nodeType !== 3 || last.nodeValue.length < extra) return;

      var tail = last.splitText(last.nodeValue.length - extra);
      m.parentNode.insertBefore(tail, m.nextSibling);
      if (!m.textContent.length) m.parentNode.removeChild(m);
      try {
        var nr = document.createRange();
        nr.setStart(tail, tail.nodeValue.length);
        nr.collapse(true);
        var sel = global.getSelection();
        sel.removeAllRanges();
        sel.addRange(nr);
      } catch (e) { /* 位置沒了就算了 */ }
    }

    document.addEventListener('selectionchange', noteCaret);
    document.addEventListener('input', function () { pullOut(); }, true);
    document.addEventListener('compositionstart', function () {
      if (!watch) noteCaret();       // 萬一 selectionchange 沒先觸發，這裡補記
      composing = true;
    }, true);
    document.addEventListener('compositionend', function () {
      /* 這裡要「當場」把記錄抓住再放行。組字結束後瀏覽器會再觸發一次
         selectionchange，若等到下一輪才讀，記錄早就被覆蓋成新長度了。 */
      var w = watch;
      composing = false;
      setTimeout(function () { pullOut(w); }, 0);
    }, true);
  };

  /* ---------- 在游標處插入文字（語音用） ---------- */
  /* 貼上含表格的內容時用的過濾器。
     一律只取純文字的話，把表格從 A 區塊複製到 B 區塊，欄位結構就沒了
     （使用者遇到的狀況）。但也不能原封不動貼進來 —— 從網頁複製會夾帶
     一堆樣式、甚至 script。所以只留下表格骨架和自己的標記，
     其餘標籤拆掉只留文字，屬性除了 colspan/rowspan 全部丟掉。
     @return 過濾後的 HTML；內容裡沒有表格時回傳空字串（交給純文字的路徑） */
  var KEEP_TAGS = /^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|BR|SPAN|B|I|U|EM|STRONG|MARK)$/;
  var KEEP_CLASS = /^(hl|fc|fs)(-\d)?$|^ocr-table$/;
  Editor.sanitizePaste = function (html) {
    var box = document.createElement('div');
    box.innerHTML = String(html || '');
    if (!box.querySelector('table')) return '';
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 8) { n.parentNode.removeChild(n); return; }      // 註解
        if (n.nodeType !== 1) return;
        if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') { n.parentNode.removeChild(n); return; }
        if (!KEEP_TAGS.test(n.tagName)) {                                   // 不保留的標籤：只留內容
          walk(n);
          var p = n.parentNode;
          while (n.firstChild) p.insertBefore(n.firstChild, n);
          p.removeChild(n);
          return;
        }
        Array.prototype.slice.call(n.attributes).forEach(function (a) {
          if (a.name === 'colspan' || a.name === 'rowspan') return;
          if (a.name === 'class') {
            var keep = a.value.split(/\s+/).filter(function (c) { return KEEP_CLASS.test(c); });
            if (keep.length) n.setAttribute('class', keep.join(' '));
            else n.removeAttribute('class');
            return;
          }
          n.removeAttribute(a.name);
        });
        walk(n);
      });
    })(box);
    Array.prototype.slice.call(box.querySelectorAll('table')).forEach(function (t) {
      if (!/\bocr-table\b/.test(t.className)) t.className = 'ocr-table';
    });
    return box.innerHTML;
  };

  Editor.insertTextAt = function (root, text) {
    if (!root || !text) return;
    /* Windows 複製出來的文字，換行是 \r\n 兩個字元。只切 \n 的話每行結尾會
       留下一個 \r —— 文字區設成保留原始空白之後，\r 也算換行，於是每行都多
       空一行（以前 \r 只被當成空白，看不出來）。先正規化再處理。
       另外，用三連點或全選複製時選取範圍會多含一個結尾換行，照著貼會在
       最後多一個空行，所以結尾的換行一律去掉。 */
    text = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!text) return;
    root.focus();
    var sel = global.getSelection();
    var range = null;
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0);
      if (root.contains(r.startContainer)) range = r;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    var frag = document.createDocumentFragment();
    var parts = String(text).split('\n');
    parts.forEach(function (p, i) {
      if (i) frag.appendChild(document.createElement('br'));
      if (p) frag.appendChild(document.createTextNode(p));
    });
    var last = frag.lastChild;
    range.insertNode(frag);
    if (last) { range.setStartAfter(last); range.collapse(true); }
    sel.removeAllRanges();
    sel.addRange(range);
    root.scrollIntoView({ block: 'nearest' });
  };

  /* ---------- HTML → DOM，換行正規化成 \n 文字節點 ---------- */
  /* 用 DOM 走訪，不用字串取代：<div> 開標籤也要換行，且不會漏掉巢狀結構 */
  Editor.htmlToDom = function (html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    Array.prototype.slice.call(d.querySelectorAll('br')).forEach(function (br) {
      br.parentNode.replaceChild(document.createTextNode('\n'), br);
    });
    /* 表格：每一格之間補跳格、每一列補換行。
       不補的話 good 和 better 會黏成 goodbetter，出考題就切不出正確的句子。 */
    Array.prototype.slice.call(d.querySelectorAll('tr')).forEach(function (tr) {
      tr.appendChild(document.createTextNode('\n'));
    });
    Array.prototype.slice.call(d.querySelectorAll('td,th')).forEach(function (td) {
      if (td.previousElementSibling) td.parentNode.insertBefore(document.createTextNode('\t'), td);
    });
    Array.prototype.slice.call(d.querySelectorAll('div,p,li')).forEach(function (el) {
      el.parentNode.insertBefore(document.createTextNode('\n'), el);
      el.appendChild(document.createTextNode('\n'));
    });
    return d;
  };

  /* ---------- 純文字（保留換行） ---------- */
  Editor.htmlToText = function (html) {
    return Editor.htmlToDom(html).textContent
      .replace(/\u00A0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };

  /* ============================================================
     文字段落的復原／重做
     不能交給瀏覽器內建的復原：螢光筆、字色是程式直接改 DOM 的，
     瀏覽器的復原紀錄不知道有這件事。標錯顏色按 Ctrl+Z，它復原的是
     它記得的上一個動作 —— 使用者打的那一整段字，標記反而留著。
     所以每個文字段落自己記一份快照紀錄：
       連續打字（間隔 1.2 秒內）合併成一步，跟一般編輯器一樣；
       標記、貼上、語音、填空這種「一次到位」的改動，前面先 checkpoint，自己算一步。
     每一步都帶時間，工具列的 ↶ 才能跟筆跡的復原排出先後。
     ============================================================ */
  var GROUP_MS = 1200, LIMIT = 100;
  /* 用區塊 id 當 key，不用元素本身：新增圖片、移動區塊時整頁會重新繪製，
     文字段落的元素整個換新。用元素當 key 的話紀錄就跟著舊元素一起丟了，
     打完字插一張圖，回來按 Ctrl+Z 會完全沒反應。 */
  var states = new Map();       // 區塊 id -> 狀態（st.root 指向目前畫面上的那個元素）
  var keyOf = new WeakMap();    // 元素 -> 區塊 id

  function textOffset(root, node, off) {
    var r = document.createRange();
    r.selectNodeContents(root);
    try { r.setEnd(node, off); } catch (e) { return 0; }
    return r.toString().length;
  }
  function snap(root) {
    var o = { html: root.innerHTML, s: -1, e: -1, at: 0 };
    var sel = global.getSelection();
    if (sel && sel.rangeCount) {
      var rg = sel.getRangeAt(0);
      if (root.contains(rg.startContainer) && root.contains(rg.endContainer)) {
        o.s = textOffset(root, rg.startContainer, rg.startOffset);
        o.e = textOffset(root, rg.endContainer, rg.endOffset);
      }
    }
    return o;
  }
  function pointAt(root, n) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), t, last = null;
    while ((t = w.nextNode())) {
      if (n <= t.nodeValue.length) return [t, n];
      n -= t.nodeValue.length;
      last = t;
    }
    return last ? [last, last.nodeValue.length] : [root, root.childNodes.length];
  }
  /* 復原標記時連選取範圍一起放回去，使用者可以馬上改標正確的顏色 */
  function restoreSel(root, o) {
    var sel = global.getSelection();
    if (!sel) return;
    try {
      var a, b;
      if (o.s < 0) { a = b = pointAt(root, 1e9); }
      else { a = pointAt(root, o.s); b = pointAt(root, o.e); }
      var r = document.createRange();
      r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
      sel.removeAllRanges(); sel.addRange(r);
    } catch (e) { /* 位置失效就算了，內容已經還原 */ }
  }

  function stateOf(root) {
    if (!root) return null;
    var st = states.get(keyOf.get(root));
    return st && st.root === root ? st : null;
  }
  function push(stack, o) { stack.push(o); if (stack.length > LIMIT) stack.shift(); }
  function notify() { if (History.onChange) History.onChange(); }

  /* DOM 被改過卻沒觸發 input（有些程式路徑會這樣）：先補記下來，
     否則復原時會連那次改動一起跳過 */
  function sync(root, st) {
    if (root.innerHTML === st.base.html) return;
    var b = st.base; b.at = Date.now();
    push(st.undo, b);
    st.redo = [];
    st.base = snap(root);
  }

  function onInput(root) {
    var st = stateOf(root);
    if (!st || st.restoring) return;
    if (root.innerHTML === st.base.html) return;       // 只有游標動、內容沒變
    var now = Date.now();
    if (st.breakNext || now - st.t > GROUP_MS) {
      var b = st.base; b.at = now;
      push(st.undo, b);
      st.breakNext = st.breakAfter;
      st.breakAfter = false;
    }
    st.redo = [];
    st.base = snap(root);
    st.t = now;
    notify();
  }

  function apply(root, st, o) {
    st.restoring = true;
    root.innerHTML = o.html;
    try { root.focus({ preventScroll: true }); } catch (e) { root.focus(); }
    restoreSel(root, o);
    /* 讓 app 的 input 監聽照常更新 b.html、存檔、空白提示；restoring 擋住自己不重記 */
    root.dispatchEvent(new Event('input', { bubbles: true }));
    st.restoring = false;
    st.base = { html: root.innerHTML, s: o.s, e: o.e, at: 0 };
    st.t = 0;
    st.breakNext = true;
    notify();
  }

  var History = {
    track: function (root, key) {
      if (!root) return;
      key = key || root;
      var st = states.get(key);
      if (st && st.root === root) return;
      if (!st) {
        st = { undo: [], redo: [], t: 0, breakNext: false, breakAfter: false, restoring: false };
        states.set(key, st);
      }
      /* 重新繪製後接回同一份紀錄：換上新元素，目前內容當作起點 */
      st.root = root;
      st.base = snap(root);
      st.breakNext = true;
      keyOf.set(root, key);
      root.addEventListener('input', function () { onInput(root); });
    },
    /* 在「一次到位」的改動之前呼叫：這次改動自己算一步，之後打的字也另起一步 */
    checkpoint: function (root) {
      var st = stateOf(root);
      if (!st) return;
      sync(root, st);
      st.base = snap(root);
      st.breakNext = true;
      st.breakAfter = true;
    },
    undo: function (root) {
      var st = stateOf(root);
      if (!st) return false;
      sync(root, st);
      if (!st.undo.length) return false;
      var o = st.undo.pop();
      var cur = snap(root); cur.at = o.at;
      push(st.redo, cur);
      apply(root, st, o);
      return true;
    },
    redo: function (root) {
      var st = stateOf(root);
      if (!st || !st.redo.length) return false;
      var o = st.redo.pop();
      var cur = snap(root); cur.at = o.at;
      push(st.undo, cur);
      apply(root, st, o);
      return true;
    },
    /* 所有段落裡「下一個該復原／重做的」是哪一段、那一步是什麼時候做的。
       復原挑最晚做的；重做挑最早被復原的（復原是從新到舊一路退回去的，
       最後被復原的那一步時間最早）。 */
    pick: function (kind) {
      var best = null;
      states.forEach(function (st) {
        var root = st.root;
        if (!root || !document.contains(root)) return;   // 那篇筆記目前沒開著
        var s = kind === 'redo' ? st.redo : st.undo;
        if (!s.length) return;
        var at = s[s.length - 1].at;
        if (!best || (kind === 'redo' ? at < best.at : at > best.at)) best = { root: root, at: at };
      });
      return best;
    },
    onChange: null
  };
  Editor.History = History;

  /* iPad 的三指滑動、搖一搖、鍵盤上的復原鍵走的是 beforeinput，不是 keydown */
  document.addEventListener('beforeinput', function (e) {
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    var root = editableRoot(e.target);
    if (!stateOf(root) || !e.cancelable) return;   // 攔不下來就別跟瀏覽器重複做
    e.preventDefault();
    if (e.inputType === 'historyUndo') History.undo(root); else History.redo(root);
  }, true);

  global.Editor = Editor;
})(window);
