/* ============================================================
   quiz.js — 從筆記自動產生考題 + 複習排程
   螢光筆語意：
     1 黃 = 挖空填空   2 綠 = 名詞解釋   3 粉 = 易錯重點
     4 藍 = 整句問答   5 紫 = 只標記不出題
   ============================================================ */
(function (global) {
  'use strict';

  var Quiz = {};
  var S = '', E = '';
  var BLANK = '＿＿＿＿';

  var TYPE_LABEL = {
    cloze: '填空', term: '名詞解釋', trap: '易錯', qa: '問答',
    def: '定義', image: '看圖', manual: '自訂', ai: 'AI'
  };
  Quiz.label = function (t) { return TYPE_LABEL[t] || '題目'; };

  /* ---------- 把 .hl 換成標記，取出純文字 ---------- */
  /* 換行若落在螢光筆範圍內，必須留在標記外面，否則前後兩行會被併成同一句 */
  function analyze(html) {
    var d = Editor.htmlToDom(html);
    var all = Array.prototype.slice.call(d.querySelectorAll('.hl'));
    var els = all.filter(function (el) { return !el.querySelector('.hl'); });
    var marks = [];
    els.forEach(function (el, i) {
      var m = (el.className.match(/hl-(\d)/) || [])[1];
      var raw = el.textContent;
      var lead = (raw.match(/^\s*/) || [''])[0];
      var rest = raw.slice(lead.length);
      var tail = (rest.match(/\s*$/) || [''])[0];
      var core = rest.slice(0, rest.length - tail.length);
      marks.push({ i: i, color: +(m || 0), text: core.replace(/\s+/g, ' ').trim() });
      var frag = document.createDocumentFragment();
      if (lead) frag.appendChild(document.createTextNode(lead));
      frag.appendChild(document.createTextNode(S + i + E));
      if (tail) frag.appendChild(document.createTextNode(tail));
      el.parentNode.replaceChild(frag, el);
    });
    return { text: d.textContent.replace(/\u00A0/g, ' '), marks: marks };
  }

  function sentences(text) {
    var out = [], buf = '', stops = '。！？；!?;\n';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      buf += ch;
      if (stops.indexOf(ch) >= 0) { if (buf.trim()) out.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function stripMarks(s, marks, exceptIdx, replacement) {
    return s.replace(/(\d+)/g, function (_, n) {
      var m = marks[+n];
      if (!m) return '';
      return (+n === exceptIdx) ? replacement : m.text;
    });
  }

  /* 一小題的開頭：1. / 2、/ (3) / （一） / 二、 */
  var ITEM_HEAD = /^\s*(?:[0-9０-９]{1,2}\s*[.、)．]|[(（][0-9０-９]{1,2}[)）]|[（(][一二三四五六七八九十]{1,3}[)）]|[一二三四五六七八九十]{1,3}\s*[、．.])/;

  /**
   * 挖空題的上下文。
   * 一小題常常跨兩行，例如：
   *     1. Jane is always a winner in writing contests.
   *        She wants to be a ____ in the future.
   * 標記在第二行，但少了第一行就answer不出來。
   * 這一句若不是以編號開頭，就往前接到最近的編號句為止。
   */
  function withContext(sents, idx, fallback) {
    if (idx < 0) return fallback;
    var host = sents[idx];
    if (ITEM_HEAD.test(host)) return host;
    for (var j = idx - 1; j >= 0 && idx - j <= 3; j--) {
      if (ITEM_HEAD.test(sents[j])) return sents.slice(j, idx + 1).join(' ');
    }
    return host;
  }

  function clip(s, n) {
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* ---------- 主產生器 ---------- */
  Quiz.generate = function (note, opts) {
    opts = opts || {};
    var useColon = opts.colon !== false;
    var out = [];
    var skipped = [];      // 整句都被標起來、挖空後沒有線索的標記
    var blanks = [];       // 只標到填空的底線本身，還沒把答案打進去
    var seen = {};
    (note.cards || []).forEach(function (c) { seen[c.q + '||' + c.a] = 1; });

    function push(card) {
      var k = card.q + '||' + card.a;
      if (!card.q || !card.a || seen[k]) return;
      seen[k] = 1;
      out.push(card);
    }

    (note.blocks || []).forEach(function (b) {
      if (b.type === 'text') {
        var A = analyze(b.html);
        var sents = sentences(A.text);

        A.marks.forEach(function (m) {
          if (!m.text || m.color === 5) return;
          /* 標到的是填空的底線本身（還沒把答案打上去）。
             照做下去答案會變成「______」，複習時永遠答不對。 */
          if (/^[_＿]{2,}$/.test(m.text.replace(/\s/g, ''))) { blanks.push(m.i); return; }
          var host = null, hostIdx = -1;
          for (var i = 0; i < sents.length; i++) {
            if (sents[i].indexOf(S + m.i + E) >= 0) { host = sents[i]; hostIdx = i; break; }
          }
          if (!host) host = S + m.i + E;

          if (m.color === 1 || m.color === 3) {
            var q = stripMarks(withContext(sents, hostIdx, host), A.marks, m.i, BLANK);
            q = clip(q, 200);
            // 挖空之後整句只剩空格 = 整行都被標起來了，出了也答不出來
            if (!q.replace(/[＿_\s]/g, '')) { skipped.push(m.text); return; }
            push(M.newCard({
              type: m.color === 3 ? 'trap' : 'cloze',
              q: (m.color === 3 ? '（易錯）' : '') + q,
              a: m.text, blockId: b.id
            }));
          } else if (m.color === 2) {
            var full = clip(stripMarks(host, A.marks, -1, ''), 160);
            push(M.newCard({
              type: 'term', q: '請解釋：' + m.text, a: full, blockId: b.id
            }));
          } else if (m.color === 4) {
            var before = host.split(S + m.i + E)[0];
            before = stripMarks(before, A.marks, -1, '').replace(/[，、：:,\s]+$/, '').trim();
            var ask = before ? clip(before, 40) : clip(m.text, 14);
            push(M.newCard({
              type: 'qa', q: '請完整說明：' + ask, a: m.text, blockId: b.id
            }));
          }
        });

        if (useColon) {
          sents.forEach(function (s) {
            var plain = stripMarks(s, A.marks, -1, '').trim();
            var mm = plain.match(/^([^：:\n]{2,24})[：:]\s*(.{3,})$/);
            if (!mm) return;
            var key = mm[1].replace(/^[0-9０-９.、()（）\s]+/, '').trim();
            var val = mm[2].replace(/[。；;]\s*$/, '').trim();
            if (!key || val.length < 3) return;
            push(M.newCard({
              type: 'def', q: '什麼是「' + key + '」？', a: clip(val, 160), blockId: b.id
            }));
          });
        }
      } else if (b.cap && b.cap.trim()) {
        var cap = b.cap.trim();
        if (/[？?]$/.test(cap)) {
          push(M.newCard({ type: 'image', q: cap, a: '（看圖回答，複習時對照圖片）', blockId: b.id }));
        } else {
          push(M.newCard({ type: 'image', q: '這張圖／這張手寫筆記在說明什麼？', a: cap, blockId: b.id }));
        }
      }
    });

    out.skipped = skipped;
    out.blanks = blanks.length;
    return out;
  };

  /* ---------- 複習佇列 ---------- */
  Quiz.buildQueue = function (notes, onlyDue) {
    var now = Date.now(), q = [];
    notes.forEach(function (n) {
      (n.cards || []).forEach(function (c) {
        if (onlyDue && c.due > now) return;
        q.push({ card: c, noteId: n.id, noteTitle: n.title || '未命名筆記' });
      });
    });
    // 易錯 & 逾期越久的優先
    q.sort(function (a, b) {
      var pa = (a.card.type === 'trap' ? -1 : 0) + a.card.box * 0.1;
      var pb = (b.card.type === 'trap' ? -1 : 0) + b.card.box * 0.1;
      if (pa !== pb) return pa - pb;
      return a.card.due - b.card.due;
    });
    return q;
  };

  Quiz.renderQ = function (q) {
    var esc = function (s) {
      return String(s).replace(/[&<>]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
      });
    };
    return esc(q).replace(/＿＿＿＿/g, '<span class="blank">？</span>').replace(/\n/g, '<br>');
  };

  /* ---------- 匯出成給 AI 的提示 ---------- */
  Quiz.aiPrompt = function (note) {
    var parts = [];
    (note.blocks || []).forEach(function (b) {
      if (b.type === 'text') {
        var t = Editor.htmlToText(b.html);
        if (t) parts.push(t);
      } else if (b.cap) {
        parts.push('［圖片說明］' + b.cap);
      }
    });
    var body = parts.join('\n\n');
    return [
      '你是我的考試家教。以下是我的讀書筆記〈' + (note.title || '未命名') + '〉。',
      '請幫我出 15 題考題，涵蓋填空、名詞解釋、問答與情境應用，難度由淺到深，並針對容易混淆的地方多出題。',
      '',
      '請「只」輸出 JSON 陣列，格式如下，不要有其他文字：',
      '[{"type":"cloze|term|qa|trap","q":"題目","a":"答案"}]',
      '',
      '=== 筆記內容開始 ===',
      body,
      '=== 筆記內容結束 ==='
    ].join('\n');
  };

  Quiz.parseImport = function (txt) {
    var s = String(txt).trim();
    var i = s.indexOf('['), j = s.lastIndexOf(']');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    var arr;
    try { arr = JSON.parse(s); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    return arr.filter(function (o) { return o && o.q && o.a; }).map(function (o) {
      return M.newCard({ type: o.type || 'ai', q: String(o.q), a: String(o.a), src: 'ai' });
    });
  };

  global.Quiz = Quiz;
})(window);
