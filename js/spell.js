/* ============================================================
   spell.js — 圖片轉文字之後的英文錯字校正

   OCR 在講義這種字體小、顏色淺的圖上，常常出現固定幾種錯：
     1. 圖示黏在字前面      oadministrator -> administrator
     2. 一個字被切成兩半    fi t / b ro ke / WO rse
     3. 形近字元看錯        l 和 i、0 和 o、9 和 g、rn 和 m
     4. 字尾表的字尾看錯    -aln -> -ain、-lclan -> -ician

   原則是「寧可不改，也不要改錯」：
     - 本來就是字典裡的字 -> 絕對不動
     - 只有在「原本不是任何字、而且改完只有一個候選是字」時才改
     - 中文完全不碰（中文字不在英文字的字元集合裡，掃不到）
   字典是本機的 words.txt（36 萬個英文單字），第一次用到才下載，
   下載失敗就整個跳過，不影響轉檔。
   ============================================================ */
(function (global) {
  'use strict';

  var Spell = {};

  /* ---------- 字典 ----------
     36 萬個字如果拆成陣列，光物件開銷就好幾十 MB。
     改成整份留著一個字串，另外記每個字的起點，用二分搜尋查 —— 記憶體約 5MB。 */
  var DICT = '', OFF = null, N = 0, loading = null;

  Spell.load = function () {
    if (loading) return loading;
    loading = fetch('words.txt', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (s) {
        if (!s) return false;
        DICT = s;
        var starts = [0], i = 0;
        while ((i = DICT.indexOf('\n', i)) >= 0) { starts.push(++i); }
        OFF = new Int32Array(starts);
        N = OFF.length;
        return true;
      })
      .catch(function () { return false; });
    return loading;
  };

  function wordAt(k) {
    var end = k + 1 < N ? OFF[k + 1] - 1 : DICT.length;
    return DICT.slice(OFF[k], end);
  }

  var ONE_LETTER = { a: 1, i: 1 };            // 字典只收兩個字母以上，這兩個要補回來

  /** 這串字母是不是字典裡的字（不分大小寫）。字典沒載好就一律回 false */
  Spell.has = function (w) {
    if (!N || !w) return false;
    w = w.toLowerCase();
    if (ONE_LETTER[w]) return true;
    var lo = 0, hi = N - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, v = wordAt(mid);
      if (v === w) return true;
      if (v < w) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  };

  /* ---------- 候選字 ---------- */
  /* OCR 最常看錯的幾組。左邊是它讀出來的，右邊是可能的真正字元 */
  var SUB = {
    l: 'i1t', i: 'l1', '1': 'li', '0': 'o', o: '0', '5': 's', s: '5',
    '9': 'g', g: '9', '8': 'b', b: '8', '6': 'b', c: 'e', e: 'c', u: 'v', v: 'u'
  };
  var PAIR = [['rn', 'm'], ['m', 'rn'], ['cl', 'd'], ['vv', 'w'], ['ii', 'u'],
    ['n', 'ri'], ['ri', 'n'], ['n', 'ii'], ['h', 'li'], ['d', 'cl'],
    ['m', 'in'], ['in', 'm'], ['m', 'ni'],
    ['Ⅱ', 'll'], ['Ⅰ', 'l'], ['Ⅲ', 'lll'], ['ⅰ', 'i'], ['ⅱ', 'ii']];

  /** 產生候選字，每個都記「改了幾個地方」。數量有上限，不然長字會爆掉 */
  function candidates(w) {
    var out = [], seen = {}, one = [];
    var push = function (s, cost) {
      if (s === w) return;
      var k = s.toLowerCase();
      if (seen[k] != null && seen[k] <= cost) return;
      seen[k] = cost;
      out.push({ s: s, cost: cost });
    };
    var find = function (w, needle) {
      /* 羅馬數字轉小寫會變成另一個羅馬數字，不能只比對小寫字串 */
      var i = w.indexOf(needle);
      return i >= 0 ? i : w.toLowerCase().indexOf(needle.toLowerCase());
    };
    for (var i = 0; i < w.length && out.length < 400; i++) {
      var ch = w.charAt(i), alt = SUB[ch.toLowerCase()];
      if (!alt) continue;
      for (var j = 0; j < alt.length; j++) {
        var s1 = w.slice(0, i) + alt.charAt(j) + w.slice(i + 1);
        push(s1, 1); one.push(s1);
      }
    }
    PAIR.forEach(function (p) {
      var pos = find(w, p[0]);
      while (pos >= 0) {
        var s2 = w.slice(0, pos) + p[1] + w.slice(pos + p[0].length);
        push(s2, 1); one.push(s2);
        var next = find(w.slice(pos + p[0].length), p[0]);
        pos = next < 0 ? -1 : pos + p[0].length + next;
      }
    });
    /* 同一個字元通常會被整批看錯（900d 的兩個 0），整批換算同一種錯 */
    Object.keys(SUB).forEach(function (ch) {
      if (w.toLowerCase().indexOf(ch) < 0) return;
      for (var j = 0; j < SUB[ch].length; j++) {
        var s3 = w.replace(new RegExp(ch, 'gi'), SUB[ch].charAt(j));
        push(s3, 1); one.push(s3);
      }
    });
    /* 再改第二個地方 */
    one.slice(0, 60).forEach(function (base) {
      for (var i = 0; i < base.length && out.length < 900; i++) {
        var ch = base.charAt(i), alt = SUB[ch.toLowerCase()];
        if (!alt) continue;
        for (var j = 0; j < alt.length; j++) push(base.slice(0, i) + alt.charAt(j) + base.slice(i + 1), 2);
      }
      PAIR.forEach(function (p) {
        var pos = find(base, p[0]);
        if (pos >= 0) push(base.slice(0, pos) + p[1] + base.slice(pos + p[0].length), 2);
      });
    });
    return out;
  }

  /**
   * 挑一個候選字：改最少的優先；同樣改最少卻有兩個以上不同的字就不猜
   * （faⅡ 可以是 fall 也可以是 fail，寧可原封不動）。
   * @param ok 判斷一個候選字算不算數（查字典，或比對字尾清單）
   */
  function bestFix(w, ok) {
    var hit = null, bestCost = 99;
    candidates(w).forEach(function (c) {
      if (c.cost > bestCost || !ok(c.s)) return;
      if (c.cost < bestCost) { bestCost = c.cost; hit = c.s; return; }
      if (hit && hit.toLowerCase() !== c.s.toLowerCase()) hit = null;   // 同分又不同字 -> 不猜
    });
    return hit;
  }

  function uniqueFix(w) { return bestFix(w, Spell.has); }

  /** 把原本的大小寫套回去：全大寫 -> 全大寫；首字大寫 -> 首字大寫 */
  function likeCase(src, fixed) {
    /* 只有「整段原本就是正常的全大寫」才維持全大寫。
       WO rse 這種是 OCR 把 wo 看成大寫，接回去要還原成小寫 */
    if (/^[A-Z]{3,}$/.test(src)) return fixed.toUpperCase();
    if (/^[A-Z]/.test(src)) return fixed.charAt(0).toUpperCase() + fixed.slice(1);
    return fixed.toLowerCase();
  }

  /* ---------- 字尾 ----------
     字尾表裡的 -ain、-ician 這種，字典幫不上忙（它們不是完整的字），
     但英文字尾就是一份固定的清單，對過去就好。 */
  var SUFFIX = ('ain aire an ian ean ese ant ent ary ate er or ar ier eur ician ' +
    'ist ite ive man woman tion sion ment ness ity ous ful less able ible ing ed ' +
    'ly ism ship hood dom age ance ence acy cy ry al ic ical ish ee eer ess ling ' +
    'let oid ify ize ise ative itive ward wise like').split(' ');

  function fixSuffix(s) {
    var low = s.toLowerCase();
    if (SUFFIX.indexOf(low) >= 0) return null;
    var hit = bestFix(low, function (c) { return SUFFIX.indexOf(c.toLowerCase()) >= 0; });
    return hit ? hit.toLowerCase() : null;
  }

  /* ---------- 主流程 ---------- */
  var WORD = /[A-Za-z0-9'’Ⅰ-Ⅳⅰ-ⅳ]+/g;

  function fixText(s) {
    var count = 0;

    /* 1. 字尾：「-」後面接幾個字母 */
    s = s.replace(/([-—–])\s?([A-Za-z]{2,10})(?![A-Za-z])/g, function (all, dash, body) {
      var f = fixSuffix(body);
      if (!f) return all;
      count++;
      return dash + likeCase(body, f);
    });

    /* 2. 一個字被切成兩三段：接起來剛好是字典裡的字，而且原本至少有一段不是字 */
    s = s.replace(/\b([A-Za-z]{1,5}) ([A-Za-z]{1,5})\b(?: ([A-Za-z]{1,5})\b)?/g, function (all, a, b, c) {
      var parts = c ? [a, b, c] : [a, b];
      var joined = parts.join('');
      if (parts.every(function (p) { return Spell.has(p); })) return all;   // 本來就都是字
      /* WO rse 這種是把小寫看成大寫，接回去要還原；真的縮寫（US A）不會這樣切 */
      if (/^[A-Z]{2}[a-z]/.test(joined)) {
        joined = joined.toLowerCase();
        if (Spell.has(joined)) { count++; return joined; }
      }
      if (Spell.has(joined)) { count++; return likeCase(a, joined); }
      if (c) {
        var two = a + b;
        if (!Spell.has(a) && !Spell.has(b) && Spell.has(two)) { count++; return likeCase(a, two) + ' ' + c; }
      }
      return all;
    });

    /* 3. 單字本身：圖示黏在前面、形近字元看錯 */
    s = s.replace(WORD, function (w, at) {
      /* 太短的不猜：三個字母的組合很容易撞到冷僻字（aln -> alii）。
         前面接「-」的是字尾，上面那條已經處理過了，不要再動它 */
      if (Spell.has(w)) return w;
      if (w.length < 3 || !/[A-Za-z]/.test(w)) return w;   // 題號「1.」這種純數字不要動
      /* 純字母的短字不猜（三個字母很容易撞到冷僻字：aln -> alii）；
         但夾了數字或羅馬數字的短字一定是認錯，可以救（faⅡ -> fall） */
      if (w.length < 4 && /^[A-Za-z]+$/.test(w)) return w;
      if (at > 0 && /[-—–]/.test(s.charAt(at - 1))) return w;
      /* 圖示（同、項目符號）被讀成一個 o/O/0 黏在字前面 */
      if (/^[oO0]/.test(w) && Spell.has(w.slice(1))) { count++; return likeCase(w.slice(1), w.slice(1)); }
      var f = uniqueFix(w);
      if (f) { count++; return likeCase(w, f); }
      /* 兩個字黏在一起：切開之後兩邊都是字，而且只有一種切法 */
      if (w.length >= 6 && /^[A-Za-z]+$/.test(w)) {
        var cut = null, many = false;
        for (var i = 3; i <= w.length - 3; i++) {
          if (!Spell.has(w.slice(0, i)) || !Spell.has(w.slice(i))) continue;
          if (cut) { many = true; break; }
          cut = i;
        }
        if (cut && !many) { count++; return w.slice(0, cut) + ' ' + w.slice(cut); }
      }
      return w;
    });

    return { text: s, count: count };
  }

  /**
   * 校正一段文字。字典還沒載好會先載（只載一次）。
   * @return Promise<{text, count}>；字典載不到就原封不動回傳
   */
  Spell.fix = function (s) {
    s = String(s || '');
    return Spell.load().then(function (ok) {
      if (!ok) return { text: s, count: 0 };
      try { return fixText(s); } catch (e) { return { text: s, count: 0 }; }
    });
  };

  global.Spell = Spell;
})(window);
