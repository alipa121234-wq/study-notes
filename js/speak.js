/* ============================================================
   speak.js — 朗讀
   用瀏覽器內建的語音合成，念的是作業系統自己的語音
   （iPad 上就是 iOS 的語音庫）。不串任何服務、不需要帳號、不花錢。
   ============================================================ */
(function (global) {
  'use strict';

  var synth = global.speechSynthesis;
  var Speak = { supported: !!(synth && global.SpeechSynthesisUtterance) };

  /* 語音清單是非同步載入的，頁面剛打開時 getVoices() 常常是空的 */
  var voices = [];
  function loadVoices() {
    try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
  }
  if (Speak.supported) {
    loadVoices();
    if (synth.addEventListener) synth.addEventListener('voiceschanged', loadVoices);
    else synth.onvoiceschanged = loadVoices;
  }

  function pickVoice(lang) {
    if (!voices.length) loadVoices();
    var want = lang.toLowerCase(), base = want.split('-')[0];
    function norm(v) { return String(v.lang || '').replace('_', '-').toLowerCase(); }
    var exact = voices.filter(function (v) { return norm(v) === want; });
    var near = exact.length ? exact : voices.filter(function (v) { return norm(v).indexOf(base) === 0; });
    /* 裝置內建的優先：不用連網、沒有延遲 */
    return near.filter(function (v) { return v.localService; })[0] || near[0] || null;
  }

  function lineSegments(line) {
    var out = [], cur = null;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      var kind = /[A-Za-z]/.test(ch) ? 'en'
        : /[\u3400-\u9fff\uf900-\ufaff]/.test(ch) ? 'zh' : null;
      if (kind && (!cur || cur.kind !== kind)) { cur = { kind: kind, text: '' }; out.push(cur); }
      if (cur) cur.text += ch;
    }
    return out.map(function (s) {
      /* 英文片段裡混到的全形括號、引號，英文語音會把符號名稱念出來 */
      var t = s.kind === 'en'
        ? s.text.replace(/[^A-Za-z0-9'’\-.,!?;:()\s]/g, ' ')
        : s.text;
      t = t.replace(/\s+/g, ' ').replace(/\s*,(\s*,)+/g, ',').replace(/ ,/g, ',')
        .replace(/^[\s,]+|[\s,]+$/g, '');
      return { kind: s.kind, text: t };
    }).filter(function (s) { return s.text; });
  }

  /**
   * 把文字切成英文、中文片段，一行一行分開。
   * 單字表常常一行一個字，不分行的話「apple」「banana」會黏成一句念完。
   * 數字和標點跟著前一段走；HTML 標籤不念；填空的底線換成逗號，
   * 語音會在那裡停一下，「The ______ was late」才不會念成「The was late」。
   */
  Speak.segments = function (text) {
    text = String(text || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[_＿]{2,}/g, ' , ');
    var out = [];
    text.split(/\r?\n/).forEach(function (line) { out = out.concat(lineSegments(line)); });
    return out;
  };

  /* all=true：中英文都念（選取的字）。
     all=false：有英文就只念英文（複習卡片 ——「什麼是「slash」？」要聽的是 slash，
     不是每張卡都先聽一次「什麼是」）。完全沒英文才念中文。 */
  function pick(text, all) {
    var segs = Speak.segments(text);
    if (all) return segs;
    var en = segs.filter(function (s) { return s.kind === 'en'; });
    return en.length ? en : segs;
  }

  /* 留住 utterance 的參考：Chrome 會把沒人參照的回收掉，onend 就永遠不會來 */
  var held = [];
  function utter(s, slow) {
    var u = new global.SpeechSynthesisUtterance(s.text);
    u.lang = s.kind === 'en' ? 'en-US' : 'zh-TW';
    var v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.rate = slow ? 0.6 : (s.kind === 'en' ? 0.9 : 1);
    held.push(u);
    if (held.length > 80) held.shift();
    return u;
  }

  /* 只有真的在念才 cancel。Chrome 在閒置時 cancel() 之後馬上 speak()
     偶爾會把新的那句吞掉；iOS 則要求 speak() 留在使用者手勢裡，
     不能用 setTimeout 繞開，所以乾脆避免不必要的 cancel。 */
  function hush() {
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();
  }

  var last = { key: '', at: 0, slow: false };

  /**
   * 念一遍。三秒內再念同一段 = 剛剛沒聽清楚，放慢再念一次；再按又回到正常速度。
   * 正在重複播放的話會先停掉。
   */
  Speak.say = function (text, opts) {
    if (!Speak.supported) return null;
    var use = pick(text, opts && opts.all);
    if (!use.length) return null;
    Speak.stopLoop('say');

    var key = use.map(function (s) { return s.text; }).join('|');
    var now = Date.now();
    var slow = key === last.key && now - last.at < 3000 && !last.slow;
    last = { key: key, at: now, slow: slow };

    hush();
    use.forEach(function (s) { synth.speak(utter(s, slow)); });
    return { slow: slow, text: key.replace(/\|/g, ' / ') };
  };

  /* ---------- 重複播放 ----------
     每一遍念完（最後一句的 onend）隔一段時間再排下一遍。
     每次開始／停止都換一個 token：cancel() 會讓正在念的那句觸發 onend／onerror，
     沒有 token 擋著的話，按了停止反而會排出下一遍。 */
  var loop = null, token = 0;

  Speak.loop = function (text, opts) {
    opts = opts || {};
    if (!Speak.supported) return null;
    var use = pick(text, opts.all !== false);
    if (!use.length) return null;
    Speak.stopLoop('restart');
    hush();
    last = { key: '', at: 0, slow: false };
    loop = {
      token: ++token, segs: use, slow: !!opts.slow, round: 0, timer: 0, dog: 0,
      gap: opts.gap || 1200, onRound: opts.onRound, onStop: opts.onStop
    };
    round(loop.token);
    return { text: use.map(function (s) { return s.text; }).join(' / ') };
  };

  function round(my) {
    if (!loop || loop.token !== my) return;
    var L = loop;
    L.round++;
    if (L.onRound) L.onRound(L.round);
    var started = false;
    L.segs.forEach(function (s, i) {
      var u = utter(s, L.slow);
      if (i === 0) u.onstart = function () { started = true; clearTimeout(L.dog); };
      if (i === L.segs.length - 1) {
        u.onend = function () {
          if (!loop || loop.token !== my) return;
          L.timer = setTimeout(function () { round(my); }, L.gap);
        };
      }
      u.onerror = function (e) {
        if (!loop || loop.token !== my) return;       // 自己按停止造成的，不算
        Speak.stopLoop('error:' + (e && e.error || ''));
      };
      synth.speak(u);
    });
    /* 看門狗：排進去了卻一直沒開始念。
       iOS 對「不是手指按下去當下」的朗讀比較嚴，第二遍之後有可能被擋；
       與其讓控制列一直顯示「播放中」卻沒聲音，不如停下來講清楚。 */
    clearTimeout(L.dog);
    L.dog = setTimeout(function () {
      if (loop && loop.token === my && !started) Speak.stopLoop('blocked');
    }, 6000);
  }

  /* 下一遍開始生效 —— 正在念的那句不打斷 */
  Speak.setLoopSlow = function (slow) { if (loop) loop.slow = !!slow; };
  Speak.looping = function () { return !!loop; };

  Speak.stopLoop = function (why) {
    token++;
    if (!loop) return;
    var L = loop;
    loop = null;
    clearTimeout(L.timer);
    clearTimeout(L.dog);
    hush();
    if (L.onStop) L.onStop(why || 'user');
  };

  Speak.stop = function () { Speak.stopLoop('user'); if (Speak.supported) hush(); };

  global.Speak = Speak;
})(window);
