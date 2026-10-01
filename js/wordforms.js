/* ============================================================
   wordforms.js — 查詢一個英文字的「四態」（動詞／名詞／形容詞／副詞）＋中文翻譯

   英文的詞性變化沒有固定公式（decide -> decision、arise -> ?），
   沒辦法用規則算出來，只能查一份有記錄「這些字本來就是同一家族」的資料庫。
   用的是普林斯頓大學的 WordNet（免費、可離線、不用帳號不用金鑰），
   裡面記了「哪個動詞對應哪個名詞、形容詞、副詞」。中文翻譯另外來自 ECDICT
   （開放的英漢字典），原始資料是簡體，轉成繁體＋台灣慣用詞（軟件->軟體、
   網絡->網路 這種）後才收進來。整理成四份檔案跟著這個 App 一起放：
     wordfamilies.txt  每一行是一個詞性家族：v:... |n:... |a:... |r:...
     wordalias.txt     這個家族裡每一個字（不管選到動詞還是名詞形）
                       都能查到同一個家族，排序過方便二分搜尋
     wordexc.txt       不規則變化（decided 之類規則變化不需要，
                       這個是給 went -> go 這種真的不規則的）
     wordcn.txt        單字 -> 中文翻譯（簡短版，取最常見的意思）
   第一次用到才下載，下載失敗就整個跳過，不影響打字。

   不是每個字都有四態 —— 很多字本來就只有名詞、沒有對應的動詞／形容詞，
   查不到的欄位留空，不會硬湊；少數常見短字（quick 之類）查出來可能混進
   近義詞，這是資料庫本身的限制，顯示出來讓使用者自己確認/刪掉。
   中文翻譯跟詞性家族是兩份獨立的資料，只要查到其中一種就會回傳結果
   （例如 cat 這種沒有跨詞性家族、但查得到翻譯的字，動/名/形/副留空，
   中文照樣顯示）。
   ============================================================ */
(function (global) {
  'use strict';

  var WordForms = {};

  var ALIAS = null;          // 排序過的 [word, famIdx] 陣列
  var FAMILIES = null;       // 每行一個家族的原始字串陣列
  var EXC = null;            // { inflected: lemma }
  var CN = null;             // { word: 中文翻譯 }
  var loading = null;

  function fetchText(name) {
    return fetch(name, { cache: 'force-cache' }).then(function (r) { return r.ok ? r.text() : ''; });
  }

  WordForms.load = function () {
    if (loading) return loading;
    loading = Promise.all([
      fetchText('wordalias.txt'), fetchText('wordfamilies.txt'),
      fetchText('wordexc.txt'), fetchText('wordcn.txt')
    ]).then(function (r) {
      if (!r[0] || !r[1]) return false;
      ALIAS = r[0].split('\n').map(function (line) {
        var i = line.indexOf('\t');
        return [line.slice(0, i), +line.slice(i + 1)];
      });
      FAMILIES = r[1].split('\n');
      EXC = {};
      (r[2] || '').split('\n').forEach(function (line) {
        var i = line.indexOf('\t');
        if (i > 0) EXC[line.slice(0, i)] = line.slice(i + 1);
      });
      CN = {};
      (r[3] || '').split('\n').forEach(function (line) {
        var i = line.indexOf('\t');
        if (i > 0) CN[line.slice(0, i)] = line.slice(i + 1);
      });
      return true;
    }).catch(function () { return false; });
    return loading;
  };

  /** 在排序過的別名表裡二分搜尋一個字，找到就回傳家族字串 */
  function findFamily(word) {
    var lo = 0, hi = ALIAS.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, w = ALIAS[mid][0];
      if (w === word) return FAMILIES[ALIAS[mid][1]];
      if (w < word) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  /* 選到的字常常是變化形（decided、applying、indicators），不會剛好是
     WordNet 收的原形，所以失敗時依序試這些常見的規則變化：
     去 s/es/ies、去 d/ed、去 ing（還原掉被吃掉的字尾 e）。
     真正不規則的（went -> go）靠 wordexc.txt。 */
  function candidates(word) {
    var out = [word];
    var push = function (w) { if (w && out.indexOf(w) < 0) out.push(w); };
    if (/ies$/.test(word)) push(word.slice(0, -3) + 'y');
    if (/[sxz]es$/.test(word) || /[cs]hes$/.test(word)) push(word.slice(0, -2));
    if (/s$/.test(word) && !/ss$/.test(word)) push(word.slice(0, -1));
    if (/ied$/.test(word)) push(word.slice(0, -3) + 'y');
    if (/ed$/.test(word)) { push(word.slice(0, -2)); push(word.slice(0, -1)); }
    if (/ing$/.test(word)) { push(word.slice(0, -3)); push(word.slice(0, -3) + 'e'); }
    return out;
  }

  /**
   * 查一個字的四態＋中文翻譯。
   * @return Promise<null | { word, v:[], n:[], a:[], r:[], cn }>
   *   word 是實際查到的那個字（可能跟輸入不同，例如輸入 decided 查到 decide）；
   *   v/n/a/r 裡沒有資料的詞性是空陣列，cn 沒查到是空字串，都不代表整體查詢失敗。
   *   兩種資料都查不到（這個字沒被任何一份資料收錄）才回傳 null。
   */
  WordForms.lookup = function (raw) {
    return WordForms.load().then(function (ok) {
      if (!ok) return null;
      var word = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!word) return null;

      var tries = candidates(word);
      if (EXC[word]) tries.splice(1, 0, EXC[word]);   // 不規則變化優先試

      for (var i = 0; i < tries.length; i++) {
        var w = tries[i];
        var row = findFamily(w);
        var cn = CN[w];
        if (!row && !cn) continue;
        var out = { word: w.replace(/_/g, ' '), v: [], n: [], a: [], r: [], cn: cn || '' };
        if (row) {
          row.split('|').forEach(function (part) {
            var pos = part.charAt(0), forms = part.slice(2).split(',');
            if (out[pos]) out[pos] = forms.map(function (f) { return f.replace(/_/g, ' '); });
          });
        }
        return out;
      }
      return null;
    });
  };

  global.WordForms = WordForms;
})(window);
