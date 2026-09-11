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

  /**
   * 把文字切成英文、中文兩種片段。
   * 數字和標點跟著前一段走；填空的底線、HTML 標籤不念。
   */
  Speak.segments = function (text) {
    text = String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      /* 填空的底線換成逗號：語音會在那裡停一下，
         「The ______ was late」才不會念成連在一起的「The was late」 */
      .replace(/[_＿]{2,}/g, ' , ');
    var out = [], cur = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
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
      t = t.replace(/\s+/g, ' ').replace(/\s*,(\s*,)+/g, ',').replace(/ ,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
      return { kind: s.kind, text: t };
    }).filter(function (s) { return s.text; });
  };

  var last = { key: '', at: 0, slow: false };

  /**
   * 念出一段文字。
   * 有英文就只念英文 —— 這是拿來背單字的，「什麼是「slash」？」
   * 要聽的是 slash，不是每張卡都先聽一次「什麼是」。完全沒有英文才念中文。
   * 三秒內再念同一段 = 剛剛沒聽清楚，放慢再念一次；再按又回到正常速度。
   */
  Speak.say = function (text) {
    if (!Speak.supported) return null;
    var segs = Speak.segments(text);
    var en = segs.filter(function (s) { return s.kind === 'en'; });
    var use = en.length ? en : segs;
    if (!use.length) return null;

    var key = use.map(function (s) { return s.text; }).join('|');
    var now = Date.now();
    var slow = key === last.key && now - last.at < 3000 && !last.slow;
    last = { key: key, at: now, slow: slow };

    /* 只有真的在念才 cancel。Chrome 在閒置時 cancel() 之後馬上 speak()
       偶爾會把新的那句吞掉；iOS 則要求 speak() 留在使用者手勢裡，
       不能用 setTimeout 繞開，所以乾脆避免不必要的 cancel。 */
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();

    use.forEach(function (s) {
      var u = new global.SpeechSynthesisUtterance(s.text);
      u.lang = s.kind === 'en' ? 'en-US' : 'zh-TW';
      var v = pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = slow ? 0.6 : (s.kind === 'en' ? 0.9 : 1);
      synth.speak(u);
    });
    return { slow: slow, text: key.replace(/\|/g, ' / ') };
  };

  Speak.stop = function () { if (Speak.supported) synth.cancel(); };

  global.Speak = Speak;
})(window);
