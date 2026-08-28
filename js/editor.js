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
    var re = kind === 'hl' ? /^hl(-\d)?$/ : /^fc(-\d)?$/;
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
  Editor.insertTextAt = function (root, text) {
    if (!root || !text) return;
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

  global.Editor = Editor;
})(window);
