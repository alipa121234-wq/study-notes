/* ============================================================
   voice.js — 語音輸入（Web Speech API）
   說出「逗號 / 句號 / 問號 / 驚嘆號 / 頓號 / 冒號 / 分號 / 換行」
   會自動轉成標點（可在語音列關掉）
   ============================================================ */
(function (global) {
  'use strict';

  var SR = global.SpeechRecognition || global.webkitSpeechRecognition;

  var PUNCT = [
    [/(逗號|逗点|逗號)/g, '，'],
    [/(句號|句点)/g, '。'],
    [/(問號|问号)/g, '？'],
    [/(驚嘆號|感嘆號|驚歎號)/g, '！'],
    [/(頓號|顿号)/g, '、'],
    [/(冒號|冒号)/g, '：'],
    [/(分號|分号)/g, '；'],
    [/(換行|斷行|下一行|新的一行)/g, '\n']
  ];

  /* 停頓多久算一句 / 算一個逗號（毫秒） */
  var PAUSE_PERIOD = 1300;
  var PAUSE_COMMA = 500;
  /* 這些詞開頭代表句子還沒結束，把句號降級成逗號 */
  var CONTINUE_WORDS = /^(然後|所以|但是|可是|因為|而且|不過|還有|另外|接著|再來|以及|或是|例如|像是)/;
  /* 句尾語氣詞 -> 問號 */
  var QUESTION_TAIL = /(嗎|呢|吧|嘛)$/;
  var ANY_PUNCT = /[，。！？、：；,.!?\n]$/;

  var Voice = {
    supported: !!SR,
    running: false,
    /* 'off' 不加 | 'spoken' 只認說出來的標點 | 'auto' 再加上停頓自動斷句 */
    punctMode: localStorage.getItem('sn_punctmode') || 'auto',
    lang: localStorage.getItem('sn_lang') || 'zh-TW',
    target: null,
    onFinal: function () { },
    onInterim: function () { },
    onState: function () { }
  };

  var rec = null, wantRun = false;
  /* 停頓量測：finalAt = 上一段講完的時刻；gap = 到下一次開口之間的靜默 */
  var lastFinalAt = 0, pendingGap = 0, gapMeasured = false, prevText = '';

  function applyPunct(s) {
    if (Voice.punctMode === 'off') return s;
    PUNCT.forEach(function (p) { s = s.replace(p[0], p[1]); });
    // 全形標點前後不需要空白
    s = s.replace(/[ \t]*([，。？！、：；])[ \t]*/g, '$1');
    s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
    return s;
  }

  /**
   * 依「上一段的內容」與「這中間停了多久」決定要補什麼標點。
   * 回傳的字會接在上一段後面（也就是新這段的前面）。
   */
  function pausePunct(gapMs, prev, next) {
    if (Voice.punctMode !== 'auto') return '';
    if (!prev || ANY_PUNCT.test(prev)) return '';
    // 幾乎沒停 → 只是同一句被切成兩段，不要插標點
    if (gapMs < PAUSE_COMMA) return '';
    if (QUESTION_TAIL.test(prev)) return '？';
    var mark = gapMs >= PAUSE_PERIOD ? '。' : '，';
    // 下一句以「然後 / 所以 / 但是…」開頭，代表話還沒講完
    if (mark === '。' && next && CONTINUE_WORDS.test(next)) mark = '，';
    return mark;
  }

  function resetPause() {
    lastFinalAt = 0; pendingGap = 0; gapMeasured = false; prevText = '';
  }

  function build() {
    rec = new SR();
    rec.lang = Voice.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = function (e) {
      var interim = '';
      var now = Date.now();

      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        var t = r[0].transcript;

        if (r.isFinal) {
          t = applyPunct(t).replace(/^\s+/, '');
          if (!t) continue;
          // 這段開口前靜默了多久（沒量到就用送達時間差當備援）
          var gap = gapMeasured ? pendingGap : (lastFinalAt ? now - lastFinalAt : 0);
          var lead = pausePunct(gap, prevText, t);
          Voice.onFinal(lead + t);
          prevText = t;
          lastFinalAt = Date.now();
          gapMeasured = false;
          pendingGap = 0;
        } else {
          interim += t;
        }
      }

      // 上一段講完之後第一次又出現 interim → 這段時間就是真正的停頓
      if (interim && !gapMeasured && lastFinalAt) {
        pendingGap = now - lastFinalAt;
        gapMeasured = true;
      }
      Voice.onInterim(interim);
    };
    rec.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRun = false;
        Voice.onState('error', '麥克風權限被拒絕，請按網址列的鎖頭開啟麥克風');
      } else if (e.error === 'no-speech') {
        /* 忽略，會自動重啟 */
      } else if (e.error === 'network') {
        Voice.onState('error', '語音辨識需要網路連線');
      }
    };
    rec.onend = function () {
      Voice.running = false;
      if (wantRun) { try { rec.start(); Voice.running = true; } catch (err) { } }
      Voice.onState(Voice.running ? 'on' : 'off');
    };
  }

  Voice.start = function (targetRoot) {
    if (!SR) { Voice.onState('error', '這個瀏覽器不支援語音輸入，請用 Chrome 或 Edge 開啟'); return; }
    Voice.target = targetRoot || null;
    if (!rec) build();
    rec.lang = Voice.lang;
    resetPause();
    wantRun = true;
    try { rec.start(); Voice.running = true; Voice.onState('on'); }
    catch (e) { /* 已在執行 */ }
  };

  Voice.stop = function () {
    wantRun = false;
    if (rec) { try { rec.stop(); } catch (e) { } }
    Voice.running = false;
    // 收尾：最後一句補上句號（或問號）
    if (Voice.punctMode === 'auto' && prevText && !ANY_PUNCT.test(prevText)) {
      Voice.onFinal(QUESTION_TAIL.test(prevText) ? '？' : '。');
    }
    resetPause();
    Voice.onState('off');
  };

  Voice.toggle = function (targetRoot) {
    if (wantRun) Voice.stop(); else Voice.start(targetRoot);
  };

  /* 給測試／除錯用 */
  Voice.punctuate = applyPunct;
  Voice.pausePunct = pausePunct;

  Voice.setPunctMode = function (m) {
    Voice.punctMode = m;
    localStorage.setItem('sn_punctmode', m);
  };
  Voice.setLang = function (l) {
    Voice.lang = l;
    localStorage.setItem('sn_lang', l);
    if (wantRun) { Voice.stop(); setTimeout(function () { Voice.start(Voice.target); }, 250); }
  };

  global.Voice = Voice;
})(window);
