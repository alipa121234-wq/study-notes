/* ============================================================
   app.js — 介面組裝與所有互動
   ============================================================ */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var notes = [];
  var folders = [];
  var note = null;
  var activeFolderId = null;        // 新筆記會建到這個資料夾
  var canvasMap = new Map();        // canvas -> block
  var ro = null;
  var mouse = { x: 0, y: 0 };
  var selectedBlockId = null;
  var collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem('sn_collapsed') || '{}'); } catch (e) { collapsed = {}; }
  function saveCollapsed() { localStorage.setItem('sn_collapsed', JSON.stringify(collapsed)); }

  /* ============================================================
     儲存
     ============================================================ */
  var saveTimer = null;
  function markDirty() {
    $('#saveState').textContent = '儲存中…';
    $('#saveState').classList.add('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }
  /* 回傳 Promise，讓「重新載入」之類的動作能等寫入真的完成 */
  function save() {
    if (!note) return Promise.resolve();
    note.updatedAt = Date.now();
    return Store.put(note).then(function () {
      $('#saveState').textContent = '已儲存 ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
      $('#saveState').classList.remove('saving');
      var i = notes.findIndex(function (n) { return n.id === note.id; });
      if (i >= 0) notes[i] = note;
      renderList();
    });
  }
  Ink.onChange = function () { markDirty(); syncUndo(); refreshHints(); };

  function syncUndo() {
    var u = $('#btnUndo'), r = $('#btnRedo');
    if (!u) return;
    u.disabled = !Ink.canUndo();
    r.disabled = !Ink.canRedo();
    u.style.opacity = u.disabled ? '.3' : '';
    r.style.opacity = r.disabled ? '.3' : '';
  }
  function doUndo() { Ink.undo(findBlock, rerenderCanvas); syncUndo(); }
  function doRedo() { Ink.redo(findBlock, rerenderCanvas); syncUndo(); }

  /* 空的手寫區顯示提示，畫上東西後隱藏 */
  function refreshHints() {
    $$('#blocks .sblock').forEach(function (el) {
      var b = findBlock(el.dataset.id);
      var h = $('.sk-hint', el);
      if (b && h) h.style.display = b.strokes.length ? 'none' : '';
    });
  }

  /* ============================================================
     側欄
     ============================================================ */
  function folderById(id) {
    return folders.filter(function (f) { return f.id === id; })[0] || null;
  }
  function notesIn(fid) {
    return notes.filter(function (n) { return (n.folderId || null) === fid; })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }
  function matches(n, kw) {
    if ((n.title || '').toLowerCase().indexOf(kw) >= 0) return true;
    return (n.blocks || []).some(function (b) {
      return b.type === 'text' && Editor.htmlToText(b.html).toLowerCase().indexOf(kw) >= 0;
    });
  }

  /* ---------- 單張筆記列 ---------- */
  function noteItem(n, showFolder) {
    var due = M.dueCount(n);
    var el = document.createElement('div');
    el.className = 'note-item' + (note && n.id === note.id ? ' active' : '');
    el.draggable = true;
    el.innerHTML =
      '<div class="t"></div>' +
      '<div class="m"><span class="d"></span>' +
      (n.cards && n.cards.length ? '<span>' + n.cards.length + ' 題</span>' : '') +
      (due ? '<span class="due">' + due + ' 待複習</span>' : '') +
      (showFolder ? '<span class="fold"></span>' : '') +
      '</div><button class="del" title="更多">⋯</button>';
    $('.t', el).textContent = n.title || '未命名筆記';
    $('.d', el).textContent = new Date(n.updatedAt).toLocaleDateString('zh-TW');
    if (showFolder) {
      var f = folderById(n.folderId);
      $('.fold', el).textContent = '📁 ' + (f ? f.name : '未分類');
    }

    el.addEventListener('click', function (e) {
      if (e.target.classList.contains('del')) return;
      openNote(n.id);
    });
    el.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/plain', n.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', function () { el.classList.remove('dragging'); });
    $('.del', el).addEventListener('click', function (e) {
      e.stopPropagation();
      noteMenu(e.currentTarget, n);
    });

    /* 筆記標題雙擊編輯 */
    $('.t', el).addEventListener('dblclick', function (e) {
      e.stopPropagation();
      promptModal('筆記標題', n.title || '').then(function (title) {
        if (title === null) return;
        title = title.trim();
        if (!title) return;
        n.title = title;
        if (note && note.id === n.id) note.title = title;
        Store.get(n.id).then(function (full) {
          if (!full) return;
          full.title = title;
          return Store.put(full);
        }).then(renderList);
      });
    });

    return el;
  }

  /* ---------- 資料夾標題列 ---------- */
  function folderRow(f) {
    var fid = f ? f.id : null;
    var kids = notesIn(fid);
    var due = kids.reduce(function (a, n) { return a + M.dueCount(n); }, 0);
    var open = !collapsed[fid || '__none'];

    var row = document.createElement('div');
    row.className = 'fold-row' + (activeFolderId === fid ? ' active' : '');
    row.innerHTML =
      '<span class="caret">' + (open ? '▼' : '▶') + '</span>' +
      (f ? '<span class="dot"></span>' : '<span class="dot" style="background:#D8D2C8"></span>') +
      '<span class="nm"></span>' +
      '<span class="cnt">' + kids.length + '</span>' +
      (due ? '<span class="due">' + due + '</span>' : '') +
      '<button class="more" title="資料夾選單">⋯</button>';
    if (f) $('.dot', row).style.background = f.color;
    var displayName = f ? f.name : (localStorage.getItem('sn_uncategorizedName') || '未分類');
    $('.nm', row).textContent = displayName;

    row.addEventListener('click', function (e) {
      if (e.target.classList.contains('more')) return;
      activeFolderId = fid;
      collapsed[fid || '__none'] = open;
      saveCollapsed();
      renderList();
    });
    $('.more', row).addEventListener('click', function (e) {
      e.stopPropagation();
      folderMenu(e.currentTarget, f);
    });

    /* 資料夾名稱雙擊編輯 */
    if (f) {
      $('.nm', row).addEventListener('dblclick', function (e) {
        e.stopPropagation();
        promptModal('資料夾名稱', f.name).then(function (name) {
          if (name === null) return;
          name = name.trim();
          if (!name) return;
          f.name = name;
          Store.putFolder(f).then(renderList);
        });
      });
    }

    /* 拖曳筆記進來 */
    row.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', function () { row.classList.remove('drop'); });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      row.classList.remove('drop');
      moveNote(e.dataTransfer.getData('text/plain'), fid);
    });

    return { row: row, kids: kids, open: open };
  }

  function renderList() {
    var box = $('#noteList');
    box.innerHTML = '';
    var kw = ($('#searchBox').value || '').trim().toLowerCase();

    /* 搜尋時改用平面清單 */
    if (kw) {
      var hits = notes.filter(function (n) { return matches(n, kw); })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      if (!hits.length) {
        box.innerHTML = '<div class="empty" style="padding:20px 6px;font-size:12px">沒有符合的筆記</div>';
        return;
      }
      hits.forEach(function (n) { box.appendChild(noteItem(n, true)); });
      return;
    }

    var groups = folders.map(function (f) { return f; });
    groups.push(null);                      // 未分類永遠排最後
    groups.forEach(function (f) {
      var g = folderRow(f);
      if (!f && !g.kids.length && folders.length) return;   // 沒有未分類的筆記就不顯示
      box.appendChild(g.row);
      if (!g.open) return;
      var kidBox = document.createElement('div');
      kidBox.className = 'fold-kids';
      if (!g.kids.length) kidBox.innerHTML = '<div class="fold-empty">（空的，可以把筆記拖進來）</div>';
      g.kids.forEach(function (n) { kidBox.appendChild(noteItem(n, false)); });
      box.appendChild(kidBox);
    });
  }

  /* ---------- 搬移 / 刪除 ---------- */
  function moveNote(noteId, folderId) {
    var n = notes.filter(function (x) { return x.id === noteId; })[0];
    if (!n || (n.folderId || null) === folderId) return;
    n.folderId = folderId;
    n.updatedAt = Date.now();
    if (note && note.id === noteId) note.folderId = folderId;
    Store.get(noteId).then(function (full) {
      if (!full) return;
      full.folderId = folderId;
      full.updatedAt = n.updatedAt;
      return Store.put(full);
    }).then(function () {
      if (folderId) collapsed[folderId] = false;
      saveCollapsed();
      renderList();
      var f = folderById(folderId);
      toast('已移到「' + (f ? f.name : '未分類') + '」');
    });
  }

  function deleteNote(n) {
    confirmModal('確定刪除「' + (n.title || '未命名筆記') + '」？此動作無法復原。').then(function (ok) {
      if (!ok) return;
      Store.del(n.id).then(function () {
        notes = notes.filter(function (x) { return x.id !== n.id; });
        if (note && note.id === n.id) {
          if (notes.length) openNote(notes[0].id); else newNote();
        } else renderList();
      });
    });
  }

  /* ============================================================
     小選單
     ============================================================ */
  var popEl = null;
  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
  }
  document.addEventListener('pointerdown', function (e) {
    if (popEl && !popEl.contains(e.target)) closePop();
  }, true);

  /**
   * items: [{label, fn, cls, dot}] ；label === '-' 為分隔線；{head:'標題'} 為小標
   */
  function popup(anchor, items) {
    closePop();
    popEl = document.createElement('div');
    popEl.id = 'popmenu';
    items.forEach(function (it) {
      if (it === '-') { var s = document.createElement('div'); s.className = 'sep'; popEl.appendChild(s); return; }
      if (it.head) { var h = document.createElement('div'); h.className = 'hd'; h.textContent = it.head; popEl.appendChild(h); return; }
      var b = document.createElement('button');
      b.className = (it.cls || '') + (it.on ? ' on' : '');
      if (it.dot) {
        var d = document.createElement('span');
        d.className = 'dot'; d.style.background = it.dot;
        b.appendChild(d);
      }
      b.appendChild(document.createTextNode(it.label));
      b.addEventListener('click', function () { closePop(); it.fn(); });
      popEl.appendChild(b);
    });
    document.body.appendChild(popEl);
    var r = anchor.getBoundingClientRect();
    var w = popEl.offsetWidth, h = popEl.offsetHeight;
    var x = Math.min(r.left, innerWidth - w - 8);
    var y = r.bottom + 4;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
    popEl.style.left = Math.max(8, x) + 'px';
    popEl.style.top = y + 'px';
  }

  function noteMenu(anchor, n) {
    var items = [{ head: '移到資料夾' }];
    folders.forEach(function (f) {
      items.push({
        label: f.name, dot: f.color, on: (n.folderId || null) === f.id,
        fn: function () { moveNote(n.id, f.id); }
      });
    });
    items.push({
      label: '未分類', dot: '#D8D2C8', on: !n.folderId,
      fn: function () { moveNote(n.id, null); }
    });
    items.push('-');
    items.push({ label: '🧠 只複習這份筆記', fn: function () { startReview([n]); } });
    items.push({
      label: '🗂 管理題庫（' + ((n.cards || []).length) + ' 題）',
      fn: function () { openCardManager(n); }
    });
    items.push({ label: '🗑 刪除筆記', cls: 'danger', fn: function () { deleteNote(n); } });
    popup(anchor, items);
  }

  function folderMenu(anchor, f) {
    var fid = f ? f.id : null;
    var kids = notesIn(fid);
    var items = [
      { label: '＋ 在這裡新增筆記', fn: function () { activeFolderId = fid; newNote(); } },
      { label: '🧠 複習這個資料夾（' + kids.length + ' 份）', fn: function () { startReview(kids); } }
    ];
    items.push('-');
    items.push({
      label: '✏️ 重新命名', fn: function () {
        var currentName = f ? f.name : (localStorage.getItem('sn_uncategorizedName') || '未分類');
        promptModal('資料夾名稱', currentName).then(function (name) {
          if (name === null) return;
          name = name.trim();
          if (!name) return;
          if (f) {
            f.name = name;
            Store.putFolder(f).then(renderList);
          } else {
            // 改名「未分類」，存在 localStorage
            localStorage.setItem('sn_uncategorizedName', name);
            renderList();
            toast('已改名為「' + name + '」');
          }
        });
      }
    });
    if (f) {
      items.push({
        label: '🎨 換顏色', dot: f.color, fn: function () {
          f.color = M.nextColor(f.color);
          Store.putFolder(f).then(renderList);
        }
      });
      items.push('-');
      items.push({
        label: '🗑 刪除資料夾', cls: 'danger', fn: function () {
          confirmModal('刪除資料夾「' + f.name + '」？\n\n裡面的 ' + kids.length + ' 份筆記不會被刪除，會移到「未分類」。').then(function (ok) {
            if (!ok) return;
            var chain = Promise.resolve();
            kids.forEach(function (n) {
              chain = chain.then(function () {
                return Store.get(n.id).then(function (full) {
                  if (!full) return;
                  full.folderId = null;
                  return Store.put(full);
                });
              });
              n.folderId = null;
              if (note && note.id === n.id) note.folderId = null;
            });
            chain.then(function () { return Store.delFolder(f.id); }).then(function () {
              folders = folders.filter(function (x) { return x.id !== f.id; });
              if (activeFolderId === f.id) activeFolderId = null;
              renderList();
              toast('已刪除資料夾，' + kids.length + ' 份筆記移到未分類');
            });
          });
        }
      });
    }
    popup(anchor, items);
  }

  function newFolder() {
    promptModal('新資料夾名稱', '').then(function (name) {
      if (name === null) return;
      name = name.trim();
      if (!name) return;
      var f = M.newFolder(name, folders.length);
      folders.push(f);
      Store.putFolder(f).then(function () {
        activeFolderId = f.id;
        collapsed[f.id] = false;
        saveCollapsed();
        renderList();
        toast('已建立資料夾「' + name + '」');
      });
    });
  }
  $('#btnNewFolder').addEventListener('click', newFolder);

  /* ============================================================
     筆記載入 / 建立
     ============================================================ */
  function openNote(id) {
    if (saveTimer) { clearTimeout(saveTimer); save(); }
    Store.get(id).then(function (n) {
      if (!n) return;
      note = n;
      activeFolderId = n.folderId || null;
      Ink.resetHistory();
      $('#noteTitle').value = n.title || '';
      renderBlocks();
      renderList();
      $('#pagewrap').scrollTop = 0;
    });
  }

  function newNote() {
    var n = M.newNote('', activeFolderId);
    notes.unshift(n);
    if (activeFolderId) { collapsed[activeFolderId] = false; saveCollapsed(); }
    Store.put(n).then(function () {
      note = n;
      Ink.resetHistory();
      $('#noteTitle').value = '';
      renderBlocks();
      renderList();
      $('#noteTitle').focus();
    });
  }

  function findBlock(id) {
    return (note.blocks || []).filter(function (b) { return b.id === id; })[0];
  }

  /* ============================================================
     區塊繪製
     ============================================================ */
  function renderBlocks() {
    var host = $('#blocks');
    host.innerHTML = '';
    canvasMap = new Map();
    if (ro) ro.disconnect();
    ro = new ResizeObserver(function (entries) {
      entries.forEach(function (en) {
        var cv = $('canvas.ink', en.target);
        if (cv && canvasMap.has(cv)) Ink.render(cv, canvasMap.get(cv));
      });
    });
    (note.blocks || []).forEach(function (b) { host.appendChild(buildBlock(b)); });
    refreshHints();
    syncUndo();
  }

  function buildBlock(b) {
    var el = document.createElement('div');
    el.className = 'block ' + (b.type === 'text' ? 'tblock' : b.type === 'image' ? 'iblock' : 'sblock');
    el.dataset.id = b.id;

    var wrap = document.createElement('div');
    wrap.className = 'inkwrap';

    var content = document.createElement('div');
    content.className = 'content';

    if (b.type === 'text') {
      content.contentEditable = 'true';
      content.spellcheck = false;
      content.setAttribute('data-ph', '在這裡打字、用觸控筆寫字、或按 🎙️ 用說的…');
      content.innerHTML = b.html || '';
      var ph = function () { content.classList.toggle('ph', !content.textContent.trim()); };
      ph();
      content.addEventListener('input', function () {
        b.html = content.innerHTML;
        ph();
        markDirty();
      });
      content.addEventListener('focus', function () { selectedBlockId = b.id; });
      /* 對 OCR 產生的 ______ 點兩下 -> 直接填答案，填完自動上螢光筆 */
      content.addEventListener('dblclick', function (e) { fillBlank(e, content, b); });
    } else if (b.type === 'image') {
      var img = document.createElement('img');
      img.src = b.src;
      img.alt = b.cap || '筆記圖片';
      img.draggable = false;
      img.addEventListener('load', function () {
        b.ratio = img.naturalHeight / img.naturalWidth;
        var cv = $('canvas.ink', el);
        if (cv) Ink.render(cv, b);
      });
      content.appendChild(img);
    } else {
      content.style.height = (b.h || 380) + 'px';
      content.style.resize = 'vertical';
      content.style.overflow = 'hidden';
      var hint = document.createElement('div');
      hint.className = 'sk-hint';
      hint.innerHTML = '✍️ <b>手寫區</b>　這一區保留原本的筆跡，<b>不會轉成文字</b><br>' +
        '按工具列的 🖊️（或鍵盤 <b>B</b>）就能直接在這裡寫字、畫圖<br>' +
        '<span class="sk-sub">想讓手寫「變成文字」請改用「＋文字」，在 🖱️ 選取模式下用觸控筆寫 · ' +
        '用不到可以按右上角 🗑 刪掉 · 右下角可拖曳改高度</span>';
      content.appendChild(hint);
      var t = null;
      new ResizeObserver(function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var h = Math.round(content.getBoundingClientRect().height);
          if (h && h !== b.h) { b.h = h; markDirty(); }
        }, 300);
      }).observe(content);
    }

    var cv = document.createElement('canvas');
    cv.className = 'ink';
    canvasMap.set(cv, b);
    Ink.attach(cv, b);

    /* 在文字段落上用觸控筆畫線，多半是想「寫字變成文字」。
       iOS 的手寫轉文字要筆能碰到文字區，但畫筆模式下畫布會把筆攔走，
       所以提醒一次該切到哪個模式。 */
    if (b.type === 'text') {
      cv.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'pen' || Ink.mode === 'select') return;
        if (sessionStorage.getItem('sn_scribblehint')) return;
        sessionStorage.setItem('sn_scribblehint', '1');
        toast('想把手寫變成文字嗎？先切到 🖱️ 選取模式，再用筆直接寫在段落上');
      }, true);
    }

    wrap.appendChild(content);
    wrap.appendChild(cv);
    el.appendChild(wrap);

    if (b.type !== 'text') {
      var cap = document.createElement('input');
      cap.className = 'cap';
      cap.placeholder = b.type === 'image' ? '圖說（會拿來出考題，寫問句就變成看圖題）' : '這段手寫在講什麼？（會拿來出考題）';
      cap.value = b.cap || '';
      cap.addEventListener('input', function () { b.cap = cap.value; markDirty(); });
      el.appendChild(cap);
    }

    var bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML =
      '<button data-a="up" title="上移">↑</button>' +
      '<button data-a="down" title="下移">↓</button>' +
      (b.type === 'image' ? '<button data-a="ocr" title="把圖片上的文字辨識成可以標記的文字">🔤</button>' : '') +
      '<button data-a="clearink" title="清除這塊的筆跡">🧹</button>' +
      '<button data-a="del" title="刪除區塊">🗑</button>';
    bar.addEventListener('click', function (e) {
      var a = e.target.dataset.a;
      if (!a) return;
      var i = note.blocks.indexOf(b);
      if (a === 'ocr') {
        popup(e.target, [
          { head: '把圖片上的文字辨識出來' },
          { label: '中文為主（含英文）', fn: function () { ocrBlock(b, el, 'zh-Hant-TW'); } },
          { label: '只有英文', fn: function () { ocrBlock(b, el, 'en-US'); } }
        ]);
        return;
      }
      if (a === 'up' && i > 0) { note.blocks.splice(i, 1); note.blocks.splice(i - 1, 0, b); renderBlocks(); }
      if (a === 'down' && i < note.blocks.length - 1) { note.blocks.splice(i, 1); note.blocks.splice(i + 1, 0, b); renderBlocks(); }
      if (a === 'clearink') {
        if (!b.strokes.length) { toast('這一塊還沒有筆跡'); return; }
        var n = b.strokes.length;
        Ink.recordErase(b.id, b.strokes);
        b.strokes = [];
        Ink.render($('canvas.ink', el), b);
        refreshHints();
        syncUndo();
        toast('已清除 ' + n + ' 筆（Ctrl+Z 可以還原）');
      }
      if (a === 'del') {
        confirmModal('刪除這個區塊？').then(function (ok) {
          if (!ok) return;
          note.blocks.splice(i, 1);
          if (!note.blocks.length) note.blocks.push(M.newBlock('text'));
          renderBlocks();
          markDirty();
        });
        return;
      }
      markDirty();
    });
    el.appendChild(bar);

    ro.observe(wrap);
    requestAnimationFrame(function () { Ink.render(cv, b); });
    return el;
  }

  /* ============================================================
     圖片轉文字（Windows 內建 OCR，由本機的 serve.py 代跑）
     ============================================================ */
  var CJK = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3000-\\u303F\\uFF00-\\uFFEF';
  /* Windows OCR 把每個中文字當成一個「詞」，字跟字中間會多空白，要接回去。
     用 lookahead 不吃掉右邊那個字，連續好幾個字一次掃描就能全部接起來。 */
  var CJK_GAP = new RegExp('([' + CJK + '])[ \\t]+(?=[' + CJK + '])', 'g');

  function tidyOcr(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(CJK_GAP, '$1')
      /* 行首的編號「1.」很常被認成小寫 L；英文裡沒有以「l.」開頭的句子 */
      .replace(/^l\.(?=\s)/gm, '1.')
      /* 填空底線後面接標點時不留空白。這裡只能比對「同一行」的空白，
         用 \s 會把換行一起吃掉，行尾的填空就會跟下一行黏在一起 */
      .replace(/______[ \t]+(?=[,.;:!?，。、；：！？])/g, '______')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  var OCR_BLANK = '______';

  /**
   * 找出圖片裡的水平底線（填空題那種）。
   * @param cv    原始解析度的圖（不要用放大過的：放大的平滑處理會把細線
   *              抹淡，本來就壓在半個像素上的線會淡到偵測不到）
   * @param scale 回傳座標要乘上的倍率，好對上 OCR 的座標系
   * @param textH 這張圖的文字高度（原始解析度）。長度、厚度的門檻都以它為基準，
   *              不用圖片尺寸 —— 同一份講義截成不同大小時判斷才會一致
   */
  function findUnderlines(cv, scale, textH) {
    if (!textH || textH < 3) return [];       // 沒認到文字就沒有基準可用
    var w = cv.width, h = cv.height;
    var data;
    try { data = cv.getContext('2d').getImageData(0, 0, w, h).data; }
    catch (e) { return []; }

    function lum(i) { return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; }

    /* 背景亮度＝出現最多次的亮度。門檻跟著背景走，
       掃描的檔、有底色的講義、深色底的圖都能用同一套判斷。 */
    var hist = new Array(256), n;
    for (n = 0; n < 256; n++) hist[n] = 0;
    for (n = 0; n < data.length; n += 4 * 5) {
      hist[Math.max(0, Math.min(255, Math.round(lum(n))))]++;
    }
    var bg = 0, best = -1;
    for (n = 0; n < 256; n++) { if (hist[n] > best) { best = hist[n]; bg = n; } }
    var DIFF = 48;

    /* 都以文字高度為基準：填空的底線至少有兩三個字寬，
       而文字自己的橫筆畫最多就一個字寬左右。
       底線也一定比文字細。 */
    var minLen = Math.round(textH * 2.5);
    var maxThick = Math.max(2, Math.round(textH * 0.3));
    var runs = [];

    /* 掃描時容忍幾個淺色像素：截圖壓縮會讓細線斷斷續續，
       完全不容忍的話一條線會被切成好幾段短的，長度就過不了篩選 */
    var GAP = Math.max(2, Math.round(textH * 0.15));
    for (var y = 0; y < h; y++) {
      var run = 0, hole = 0;
      for (var x = 0; x <= w; x++) {
        var dark = false;
        if (x < w) {
          var i = (y * w + x) * 4;
          if (data[i + 3] > 128) dark = Math.abs(lum(i) - bg) > DIFF;
        }
        if (dark) { run += hole + 1; hole = 0; continue; }
        if (run > 0 && hole < GAP) { hole++; continue; }
        if (run >= minLen) runs.push({ y: y, x1: x - hole - run, x2: x - hole - 1 });
        run = 0; hole = 0;
      }
    }
    if (!runs.length) return [];

    /* 同一條線會在連續好幾個 y 都出現，合併成一塊再判斷厚度 */
    var blocks = [];
    runs.forEach(function (r) {
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (r.y - b.y2 <= 1 && r.x1 < b.x2 && r.x2 > b.x1) {
          b.y2 = r.y;
          b.x1 = Math.min(b.x1, r.x1);
          b.x2 = Math.max(b.x2, r.x2);
          return;
        }
      }
      blocks.push({ y1: r.y, y2: r.y, x1: r.x1, x2: r.x2 });
    });

    var s = scale || 1;
    return blocks.filter(function (b) {
      return (b.y2 - b.y1 + 1) <= maxThick && (b.x2 - b.x1 + 1) >= minLen;
    }).map(function (b) {
      return { y1: b.y1 * s, y2: b.y2 * s, x1: b.x1 * s, x2: b.x2 * s };
    });
  }

  /**
   * 把 OCR 回傳的片段依座標重組成一頁文字。
   * 一行可能被填空的底線切成好幾段，而且回傳順序不照畫面位置，
   * 所以要自己分列、由左到右排、再把底線還原成 ______。
   */
  function assembleOcr(lines, lead) {
    var items = (lines || []).filter(function (l) {
      return l && String(l.t || '').trim() && l.h > 0;
    }).map(function (l) {
      return {
        t: String(l.t), left: l.x, right: l.x + l.w, h: l.h, mid: l.y + l.h / 2
      };
    });
    if (!items.length) return '';
    items.sort(function (a, b) { return (a.mid - b.mid) || (a.left - b.left); });

    /* 垂直中心差距小於半個字高 = 同一列 */
    var rows = [];
    items.forEach(function (it) {
      var last = rows[rows.length - 1];
      if (last && Math.abs(last.mid - it.mid) <= Math.max(last.h, it.h) * 0.5) {
        last.parts.push(it);
        return;
      }
      rows.push({ mid: it.mid, h: it.h, parts: [it] });
    });

    lead = lead || [];

    /* 每一列的垂直範圍：自己的頂端 ~ 與下一列之間的中線。
       底線落在哪一段就算哪一列的。
       不能用「離中心多遠」來判斷 —— 沒有下伸筆畫的句子
       （Karen has a nice voice 裡沒有 g/p/y）框會矮一截，
       門檻跟著變小，底線就會剛好被剔除掉。 */
    rows.forEach(function (r) {
      var tops = r.parts.map(function (p) { return p.mid - p.h / 2; });
      var bots = r.parts.map(function (p) { return p.mid + p.h / 2; });
      r.top = Math.min.apply(null, tops);
      r.bot = Math.max.apply(null, bots);
    });
    rows.forEach(function (r, i) {
      var next = rows[i + 1];
      r.zoneBot = next ? Math.max(r.bot, (r.bot + next.top) / 2) : r.bot + r.h;
    });
    rows.forEach(function (r, i) {
      r.zoneTop = i ? rows[i - 1].zoneBot : r.top - r.h;   // 讓各列的範圍相連，不留空隙
    });

    return rows.map(function (row) {
      row.parts.sort(function (a, b) { return a.left - b.left; });

      /* 屬於這一列、而且不是壓在文字底下的底線
         （判斷「有多少比例沒被文字蓋到」，不去比座標大小 ——
           OCR 給的文字框右緣常常比實際字尾多出一二十像素，
           拿它當基準會對不上。強調用的底線整條都在字下面，會被擋掉。） */
      var mine = lead.filter(function (u) {
        var uy = (u.y1 + u.y2) / 2;
        if (uy < row.zoneTop || uy >= row.zoneBot) return false;
        var len = u.x2 - u.x1;
        if (len < row.h * 1.5) return false;      // 「一」「二」的橫筆沒這麼長
        var covered = 0;
        row.parts.forEach(function (p) {
          covered += Math.max(0, Math.min(p.right, u.x2) - Math.max(p.left, u.x1));
        });
        return (len - covered) >= len * 0.5;
      });

      /* 文字片段和底線混在一起，單純由左到右排。
         這樣「結尾的底線」自然排在最後，不必再判斷它是不是在文字右邊。 */
      var seq = row.parts.map(function (p) {
        return { left: p.left, right: p.right, t: p.t };
      }).concat(mine.map(function (u) {
        return { left: u.x1, right: u.x2, t: null };
      })).sort(function (a, b) { return a.left - b.left; });

      var out = [], prev = null;
      seq.forEach(function (s) {
        if (s.t === null) {
          if (out[out.length - 1] !== OCR_BLANK) out.push(OCR_BLANK);
          return;
        }
        /* 沒偵測到底線時的備援：兩段文字之間空太多，也當成填空 */
        if (prev && out[out.length - 1] !== OCR_BLANK &&
          (s.left - prev.right) > row.h * 1.2) {
          out.push(OCR_BLANK);
        }
        out.push(s.t);
        prev = s;
      });
      return out.join(' ');
    }).join('\n');
  }

  function ocrBlock(b, el, lang) {
    var img = $('img', el);
    if (!img || !img.complete || !img.naturalWidth) { toast('圖片還沒載入完，稍等一下再試'); return; }
    toast('辨識中…');

    var w = img.naturalWidth, h = img.naturalHeight;
    var f = Math.max(w, h) < 1600 ? 2 : 1;

    /* 底線在「原始解析度」上找。放大用的平滑處理會把細線抹淡，
       本來就壓在半個像素上的線會淡到偵測不到。
       實際偵測要等 OCR 回來 —— 門檻是以文字高度為基準的。 */
    var src = document.createElement('canvas');
    src.width = w; src.height = h;
    src.getContext('2d').drawImage(img, 0, 0);

    /* 文字則相反：小圖先放大再送去辨識，準確度差很多 */
    var cv = document.createElement('canvas');
    cv.width = w * f; cv.height = h * f;
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cv.width, cv.height);

    cv.toBlob(function (blob) {
      if (!blob) { toast('圖片轉檔失敗'); return; }
      /* 用相對路徑：部署到 GitHub Pages 時網址帶子路徑，絕對路徑會指到根目錄 */
      fetch('ocr?lang=' + encodeURIComponent(lang), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob
      }).then(function (r) {
        return r.json().catch(function () { throw new Error('伺服器沒有回應（HTTP ' + r.status + '）'); })
          .then(function (j) {
            if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
            return j;
          });
      }).then(function (j) {
        /* 用辨識到的文字高度中位數當基準去找底線 */
        var hs = (j.lines || []).map(function (l) { return l.h; })
          .filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
        var textH = hs.length ? hs[Math.floor(hs.length / 2)] / f : 0;
        var lead = findUnderlines(src, f, textH);
        var text = tidyOcr(assembleOcr(j.lines, lead));
        if (!text) { toast('這張圖沒有辨識到文字'); return; }
        addTextAfter(b, text);
        toast('已轉成 ' + text.split('\n').length + ' 行文字 —— 請先校對錯字再標記');
      }).catch(function (e) {
        toast('辨識失敗：' + e.message);
      });
    }, 'image/png');
  }

  /**
   * 對填空的 ______ 點兩下，跳出輸入框填答案。
   * 填完直接換成有螢光筆標記的文字，省掉「先打字、再選取、再按 Alt+1」三個動作。
   * 沒點在底線上就什麼也不做，維持原本的選字行為。
   */
  function fillBlank(e, root, blk) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var node = sel.getRangeAt(0).startContainer;
    if (node.nodeType !== 3 || !root.contains(node)) return;

    /* 找出游標所在位置的那一串底線 */
    var v = node.nodeValue, off = sel.getRangeAt(0).startOffset;
    var s = off, t = off;
    while (s > 0 && v[s - 1] === '_') s--;
    while (t < v.length && v[t] === '_') t++;
    if (t - s < 2) return;                    // 不是點在底線上

    e.preventDefault();
    promptModal('這一格的答案是？', '').then(function (ans) {
      if (ans === null) return;
      ans = ans.trim();
      if (!ans) return;
      /* 用 range 換掉那串底線，再選起來套上「挖空填空」的黃色 */
      var r = document.createRange();
      r.setStart(node, s); r.setEnd(node, t);
      r.deleteContents();
      var tn = document.createTextNode(ans);
      r.insertNode(tn);
      var pick = document.createRange();
      pick.setStart(tn, 0); pick.setEnd(tn, ans.length);
      sel.removeAllRanges(); sel.addRange(pick);
      root.focus();
      Editor.mark('hl', 1);
      blk.html = root.innerHTML;
      markDirty();
      toast('已填入「' + ans + '」並標成挖空題');
    });
  }

  function addTextAfter(b, text) {
    var i = note.blocks.indexOf(b);
    var nb = M.newBlock('text', { html: esc(text).replace(/\n/g, '<br>') });
    note.blocks.splice(i + 1, 0, nb);
    renderBlocks();
    markDirty();
  }

  function rerenderCanvas(blockId) {
    var el = $('.block[data-id="' + blockId + '"] canvas.ink');
    var b = findBlock(blockId);
    if (el && b) Ink.render(el, b);
  }

  /* ============================================================
     新增區塊
     ============================================================ */
  function addBlock(type, extra, focus) {
    var b = M.newBlock(type, extra);
    var idx = note.blocks.length;
    if (selectedBlockId) {
      var i = note.blocks.findIndex(function (x) { return x.id === selectedBlockId; });
      if (i >= 0) idx = i + 1;
    }
    note.blocks.splice(idx, 0, b);
    renderBlocks();
    markDirty();
    if (focus !== false) {
      var el = $('.block[data-id="' + b.id + '"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        var c = $('.content[contenteditable]', el);
        if (c) c.focus();
      }
    }
    return b;
  }

  /* ============================================================
     圖片：貼上 / 拖曳 / 選檔
     ============================================================ */
  function fileToBlock(file) {
    return new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var maxW = 1600;
          var w = img.naturalWidth, h = img.naturalHeight;
          var src = fr.result;
          if (w > maxW) {
            var s = maxW / w;
            var c = document.createElement('canvas');
            c.width = Math.round(w * s); c.height = Math.round(h * s);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            src = c.toDataURL('image/png');
            if (src.length > 1.2e6) src = c.toDataURL('image/jpeg', 0.88);
            w = c.width; h = c.height;
          } else if (fr.result.length > 1.6e6) {
            var c2 = document.createElement('canvas');
            c2.width = w; c2.height = h;
            c2.getContext('2d').drawImage(img, 0, 0);
            src = c2.toDataURL('image/jpeg', 0.88);
          }
          res({ src: src, ratio: h / w });
        };
        img.onerror = function () { res(null); };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function insertImages(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (!list.length) return;
    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        return fileToBlock(f).then(function (o) {
          if (o) addBlock('image', { src: o.src, ratio: o.ratio }, false);
        });
      });
    });
    chain.then(function () {
      markDirty();
      var last = $('#blocks').lastElementChild;
      if (last) last.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  document.addEventListener('paste', function (e) {
    if (!note) return;
    var items = (e.clipboardData || {}).items || [];
    var imgs = [];
    for (var i = 0; i < items.length; i++) {
      if (/^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) { e.preventDefault(); insertImages(imgs); return; }
    // 純文字貼上（避免帶進外部樣式）
    var root = Editor.currentRoot();
    if (root && e.clipboardData) {
      var txt = e.clipboardData.getData('text/plain');
      if (txt) { e.preventDefault(); Editor.insertTextAt(root, txt); root.dispatchEvent(new Event('input')); }
    }
  });

  ['dragover', 'drop'].forEach(function (ev) {
    $('#pagewrap').addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files.length) insertImages(e.dataTransfer.files);
    });
  });

  $('#filePicker').addEventListener('change', function (e) {
    insertImages(e.target.files);
    e.target.value = '';
  });

  /* ============================================================
     工具列
     ============================================================ */
  function renderSwatches() {
    var host = $('#swatches');
    var cols = Ink.palette(), names = Ink.paletteNames();
    host.innerHTML = '';
    var active = (Ink.mode === 'hl') ? Ink.tools.hl.colorIdx : Ink.tools.pen.colorIdx;
    cols.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'sw' + (i === active ? ' active' : '');
      b.style.background = c;
      b.title = names[i] + '（快捷鍵 ' + (i + 1) + '）';
      b.addEventListener('click', function () { Ink.setColor(i); });
      host.appendChild(b);
    });
  }

  /* ============================================================
     觸控裝置：手掌防誤觸、側欄開關、選取後的浮動標記列
     ============================================================ */
  var TOUCH = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

  /* 擋掉手指作畫時，要把 touch-action 還給瀏覽器，手指才捲得動頁面 */
  function syncPenOnly() {
    var blocked = Ink.fingerBlocked();
    document.body.classList.toggle('pen-only', blocked);
    var b = $('#btnPenOnly');
    if (!b) return;
    b.textContent = blocked ? '✏️' : '✋';
    b.title = blocked
      ? '目前只有觸控筆能畫，手指用來捲動（點一下改成手指也能畫）'
      : '目前手指也能畫（點一下改成只有觸控筆能畫，手指用來捲動）';
    b.classList.toggle('on', blocked);
  }

  function initTouchUI() {
    /* 加到主畫面後沒有網址列，iOS 也停用了下拉重新整理，
       等於沒辦法載入新版程式。存好檔再重新載入。 */
    $('#btnReload').addEventListener('click', function () {
      if (saveTimer) clearTimeout(saveTimer);
      /* 一定要換一個沒看過的網址。單純 reload() 會拿到快取裡的 index.html
         （GitHub Pages 叫瀏覽器存十分鐘），裡面還是指向舊版的 JS，
         看起來就像「明明更新了卻沒生效」。 */
      var go = function () {
        location.replace(location.pathname + '?r=' + Date.now());
      };
      save().then(go, go);
    });

    $('#btnPenOnly').addEventListener('click', function () {
      Ink.setPenOnly(Ink.fingerBlocked() ? 'finger' : 'pen');
      toast(Ink.fingerBlocked()
        ? '只有觸控筆能畫，手指可以捲頁面'
        : '手指也能畫了（手掌可能會誤觸）');
    });

    function closeSide() { document.body.classList.remove('side-open'); }
    $('#btnSide').addEventListener('click', function (e) {
      e.stopPropagation();
      document.body.classList.toggle('side-open');
    });
    $('#sideMask').addEventListener('click', closeSide);
    $('#noteList').addEventListener('click', function () {
      if (innerWidth <= 820) closeSide();
    });

    /* 沒有實體鍵盤就按不出 Alt+1~5，改成選取文字後浮一排顏色出來 */
    var bar = $('#selbar');
    var savedRange = null;      // iOS 上點按鈕會把選取收掉，先存起來待會還原
    var LABEL = ['挖空填空', '名詞解釋', '易錯重點', '整句問答', '只標記'];

    /**
     * 觸控裝置上的按鈕要用 touchend 直接觸發。
     * 千萬不能在 touchstart 上 preventDefault —— 那會讓 iOS 不再合成 click，
     * 按鈕就完全按不動了（看得到、點不到）。
     * 選取被收走的問題改由 applySel() 還原 savedRange 處理。
     */
    function onTap(el, fn) {
      var viaTouch = false;
      el.addEventListener('touchend', function (e) {
        e.preventDefault();          // 這裡擋掉就不會再補一次 click
        viaTouch = true;
        fn();
        setTimeout(function () { viaTouch = false; }, 500);
      }, { passive: false });
      el.addEventListener('click', function () { if (!viaTouch) fn(); });
      /* 滑鼠按下時不要讓選取消失（桌機） */
      el.addEventListener('mousedown', function (e) { e.preventDefault(); });
    }

    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.className = 'sw hl-' + n;
        b.title = LABEL[n - 1];
        b.textContent = n;
        onTap(b, function () { applySel('hl', n); });
        bar.appendChild(b);
      })(i);
    }
    var clr = document.createElement('button');
    clr.textContent = '✕';
    clr.title = '清除標記';
    onTap(clr, function () { applySel('hl', 0); });
    bar.appendChild(clr);

    function applySel(kind, n) {
      /* 就算前面擋不住，這裡再把選取範圍放回去 —— 不然套用時
         選取是空的，按了完全沒反應（顏色不會出現） */
      var sel = window.getSelection();
      if (savedRange && (!sel.rangeCount || sel.isCollapsed)) {
        try { sel.removeAllRanges(); sel.addRange(savedRange); } catch (e) { /* 已失效 */ }
      }
      if (n) Editor.mark(kind, n); else Editor.clearMarks();
      var root = Editor.currentRoot();
      if (root) root.dispatchEvent(new Event('input'));
      hideSel();
    }
    function hideSel() { bar.classList.remove('on'); savedRange = null; }

    /* 在標題欄選字是常見的誤會：標題是 <input>，放不了螢光筆的標記，
       出題也只認文字段落。與其讓色條默默不出現，不如講清楚。 */
    function titleHint() {
      var ti = $('#noteTitle');
      if (document.activeElement !== ti) return;
      if (ti.selectionStart === ti.selectionEnd) return;
      if (sessionStorage.getItem('sn_titlehint')) return;
      sessionStorage.setItem('sn_titlehint', '1');
      toast('標題不能上螢光筆。請在下面的段落裡打字，選取那裡的文字才能標記出題');
    }

    function placeSel() {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !Editor.currentRoot()) {
        hideSel();
        titleHint();
        return;
      }
      var range = sel.getRangeAt(0);
      var r = range.getBoundingClientRect();
      if (!r.width && !r.height) { hideSel(); return; }
      savedRange = range.cloneRange();
      bar.classList.add('on');
      var w = bar.offsetWidth || 220, h = bar.offsetHeight || 44;

      if (TOUCH) {
        /* 停在畫面底部，不要黏著選取範圍跑。
           iOS 自己的「拷貝／查詢」選單會依剩餘空間自行決定放上面或下面，
           沒有哪一側是安全的 —— 唯一不會撞到的方法就是離它遠一點。
           用 visualViewport 才能停在鍵盤上方。 */
        var vv = window.visualViewport;
        var bottom = vv ? (vv.offsetTop + vv.height) : innerHeight;
        bar.style.left = '50%';
        bar.style.transform = 'translateX(-50%)';
        bar.style.top = Math.max(8, bottom - h - 12) + 'px';
        return;
      }

      bar.style.transform = '';
      var x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      var above = r.top - h - 12, below = r.bottom + 12;
      var y = above >= 8 ? above : Math.min(innerHeight - h - 8, below);
      bar.style.left = x + 'px';
      bar.style.top = Math.max(8, y) + 'px';
    }

    /* Safari 的 selectionchange 不一定會為 contenteditable 觸發，
       所以手勢結束後也主動檢查一次。延遲是等 iOS 把選取範圍定下來。 */
    var t = null;
    function recheck(delay) {
      clearTimeout(t);
      t = setTimeout(placeSel, delay || 0);
    }
    document.addEventListener('selectionchange', function () { recheck(0); });
    document.addEventListener('pointerup', function () { recheck(60); });
    document.addEventListener('touchend', function () { recheck(120); });
    document.addEventListener('keyup', function (e) {
      if (e.shiftKey || /^Arrow/.test(e.key)) recheck(0);
    });
    /* 鍵盤彈出／收起、轉向時可視範圍會變，停在底部的色條要跟著移動 */
    if (window.visualViewport) {
      ['resize', 'scroll'].forEach(function (ev) {
        window.visualViewport.addEventListener(ev, function () {
          if (bar.classList.contains('on')) recheck(0);
        });
      });
    }
    /* 切到畫筆之後就不該再浮著擋畫面 */
    var prevToolChange = Ink.onToolChange;
    Ink.onToolChange = function () {
      if (typeof prevToolChange === 'function') prevToolChange();
      if (Ink.mode !== 'select') hideSel();
    };
  }

  /* ============================================================
     診斷：iPad 上的問題在 NB 重現不出來，需要真機的數據
     ============================================================ */
  var evLog = [];
  function logEv(e) {
    var last = evLog[evLog.length - 1];
    if (e.type === 'pointermove') {
      /* move 太多，只累加次數不要洗版 */
      if (last && last.t === 'move' && last.pt === e.pointerType) { last.n++; return; }
      evLog.push({ t: 'move', pt: e.pointerType, n: 1 });
    } else {
      evLog.push({ t: e.type.replace('pointer', ''), pt: e.pointerType, n: 0 });
    }
    if (evLog.length > 14) evLog.shift();
  }
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('ink')) logEv(e);
    }, true);
  });

  function diagText() {
    var cv = $('#blocks canvas.ink');
    var ta = cv ? getComputedStyle(cv).touchAction : '(沒有畫布)';
    var pe = cv ? getComputedStyle(cv).pointerEvents : '-';
    var L = evLog.map(function (x) {
      return '  ' + x.t + (x.n > 1 ? ' ×' + x.n : '') + '  ' + (x.pt || '?');
    }).join('\n') || '  （還沒有事件 —— 請先在畫布上寫一筆再打開）';
    return [
      '模式: ' + Ink.mode,
      '手掌防誤觸: ' + (Ink.fingerBlocked() ? '開（只有筆能畫）' : '關（手指也能畫）'),
      '  penOnly=' + Ink.penOnly + '  sawPen=' + Ink.sawPen,
      '畫布 touch-action: ' + ta,
      '畫布 pointer-events: ' + pe,
      '螢幕: ' + innerWidth + '×' + innerHeight + '  DPR=' + (devicePixelRatio || 1) +
      '  觸控點=' + (navigator.maxTouchPoints || 0),
      'UA: ' + navigator.userAgent.slice(0, 90),
      '',
      '最近在畫布上的指標事件：',
      L
    ].join('\n');
  }

  /* 跟瀏覽器要求「不要自動清掉」。iOS Safari 網站放 7 天沒開就會把
     IndexedDB 清掉，加到主畫面 + 這個要求才留得住。 */
  function keepStorage() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage.persisted().then(function (ok) {
      if (!ok) navigator.storage.persist();
    }).catch(function () { });
  }

  function syncToolbar() {
    $$('.tool').forEach(function (t) {
      t.classList.toggle('active', t.dataset.mode === (Ink.mode === 'select' ? 'select' : Ink.mode));
    });
    renderSwatches();
    var d = Math.max(3, Math.min(26, Ink.curSize()));
    var dot = $('#sizeDot i');
    dot.style.width = d + 'px'; dot.style.height = d + 'px';
    dot.style.background = Ink.mode === 'eraser' ? '#C9C4BC' : Ink.curColor();
    var names = { select: '選取／打字', pen: '畫筆', hl: '螢光筆', eraser: '橡皮擦' };
    $('#modeState').textContent = names[Ink.mode] + ' · ' + Ink.curSize() + 'px';
    syncPenOnly();
    var pc = $('#penCursor');
    if (pc) {
      var s = Ink.mode === 'eraser' ? Ink.tools.eraser.size : Ink.curSize();
      pc.style.width = s + 'px'; pc.style.height = s + 'px';
      pc.style.borderColor = Ink.mode === 'eraser' ? '#8A8680' : Ink.curColor();
      pc.style.background = Ink.mode === 'hl' ? Ink.curColor() + '55' : 'transparent';
    }
  }
  Ink.onToolChange = syncToolbar;

  $$('.tool').forEach(function (t) {
    t.addEventListener('click', function () { Ink.setMode(t.dataset.mode); });
  });
  $('#btnUndo').addEventListener('click', doUndo);
  $('#btnRedo').addEventListener('click', doRedo);
  $('#btnThin').addEventListener('click', function () { Ink.stepSize(-1); });
  $('#btnThick').addEventListener('click', function () { Ink.stepSize(1); });
  $('#sizeDot').addEventListener('wheel', function (e) {
    e.preventDefault(); Ink.nudgeSize(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  $('#btnAddText').addEventListener('click', function () { addBlock('text'); });
  $('#btnAddSketch').addEventListener('click', function () { addBlock('sketch', null, false); Ink.setMode('pen'); });
  $('#btnAddImage').addEventListener('click', function () { $('#filePicker').click(); });
  $('#btnNewNote').addEventListener('click', newNote);
  $('#searchBox').addEventListener('input', renderList);
  $('#noteTitle').addEventListener('input', function () { note.title = $('#noteTitle').value; markDirty(); });

  /* ============================================================
     筆跡游標
     ============================================================ */
  (function () {
    var pc = document.createElement('div');
    pc.id = 'penCursor';
    document.body.appendChild(pc);
    document.addEventListener('pointermove', function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY;
      pc.style.left = e.clientX + 'px';
      pc.style.top = e.clientY + 'px';
      if (Ink.radialIsOpen()) Ink.radialMove(e.clientX, e.clientY);
    });
  })();

  /* ============================================================
     輪盤：按住空白鍵 / 滑鼠右鍵
     ============================================================ */
  $('#pagewrap').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  $('#pagewrap').addEventListener('pointerdown', function (e) {
    if (e.button === 2) { e.preventDefault(); Ink.radialOpen(e.clientX, e.clientY); }
  });
  document.addEventListener('pointerup', function (e) {
    if (e.button === 2 && Ink.radialIsOpen()) Ink.radialClose(true);
  });

  /* ============================================================
     鍵盤快捷鍵
     ============================================================ */
  function isEditing(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  var springFrom = null;

  document.addEventListener('keydown', function (e) {
    var editing = isEditing(document.activeElement);
    var code = e.code, k = e.key;

    if (k === 'F2') { e.preventDefault(); toggleVoice(); return; }
    if (k === 'Escape') {
      if (popEl) { closePop(); return; }
      if (Ink.radialIsOpen()) { Ink.radialClose(false); return; }
      if (!$('#modal').hidden) { closeModal(); return; }
      if (editing) document.activeElement.blur();
      Ink.setMode('select');
      return;
    }

    /* --- Alt 系列：任何時候都能用 --- */
    if (e.altKey && !e.ctrlKey) {
      var dm = code.match(/^Digit([0-5])$/);
      if (dm) {
        e.preventDefault();
        var n = +dm[1];
        if (editing) {
          if (n === 0) Editor.clearMarks();
          else Editor.mark(e.shiftKey ? 'fc' : 'hl', n);
          var root = Editor.currentRoot();
          if (root) root.dispatchEvent(new Event('input'));
        } else if (n > 0) Ink.setColor(n - 1);
        return;
      }
      if (k.toLowerCase() === 'q') { e.preventDefault(); manualCard(); return; }
      if (k.toLowerCase() === 'b') { e.preventDefault(); Ink.setMode('pen'); return; }
      if (k.toLowerCase() === 'h') { e.preventDefault(); Ink.setMode('hl'); return; }
      if (k.toLowerCase() === 'e') { e.preventDefault(); Ink.setMode('eraser'); return; }
      if (k.toLowerCase() === 'v') { e.preventDefault(); Ink.setMode('select'); return; }
    }

    if (e.ctrlKey && k.toLowerCase() === 's') { e.preventDefault(); save(); return; }

    /* 復原／重做：畫筆模式下即使游標還在文字區也要作用在筆跡 */
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      var kk = k.toLowerCase();
      var inkScope = !editing || Ink.mode !== 'select';
      if (kk === 'z' && inkScope) {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if (kk === 'y' && inkScope) { e.preventDefault(); doRedo(); return; }
    }

    if (editing) return;

    /* --- 非編輯狀態的單鍵快捷 --- */
    if (e.ctrlKey || e.metaKey) return;

    if (code === 'Space') {
      e.preventDefault();
      if (!Ink.radialIsOpen()) Ink.radialOpen(mouse.x, mouse.y);
      return;
    }
    if (k === 'Tab') { e.preventDefault(); Ink.swapPen(); return; }

    var d = code.match(/^Digit([1-5])$/);
    if (d) { e.preventDefault(); Ink.setColor(+d[1] - 1); return; }
    if (code === 'BracketLeft') { e.preventDefault(); Ink.stepSize(-1); return; }
    if (code === 'BracketRight') { e.preventDefault(); Ink.stepSize(1); return; }

    switch (k.toLowerCase()) {
      case 'v': Ink.setMode('select'); break;
      case 'b': Ink.setMode('pen'); break;
      case 'h': Ink.setMode('hl'); break;
      case 'e': Ink.setMode('eraser'); break;
      case 'x':
        if (!springFrom && Ink.mode !== 'eraser') {
          springFrom = { mode: Ink.mode };
          Ink.setMode('eraser', false);
        }
        break;
    }
  });

  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' && Ink.radialIsOpen()) Ink.radialClose(true);
    if (e.key.toLowerCase() === 'x' && springFrom) {
      Ink.setMode(springFrom.mode, false);
      springFrom = null;
    }
  });

  /* Ctrl+滾輪調粗細 */
  $('#pagewrap').addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    Ink.nudgeSize(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  /* 點空白處記錄目前區塊 */
  $('#blocks').addEventListener('pointerdown', function (e) {
    var b = e.target.closest ? e.target.closest('.block') : null;
    if (b) selectedBlockId = b.dataset.id;
  });

  /* ============================================================
     語音
     ============================================================ */
  function currentTextRoot() {
    var root = Editor.currentRoot();
    if (root) return root;
    var el = selectedBlockId && $('.block[data-id="' + selectedBlockId + '"] .content[contenteditable]');
    if (el) return el;
    var last = $$('#blocks .tblock .content').pop();
    if (last) return last;
    var b = addBlock('text', null, false);
    return $('.block[data-id="' + b.id + '"] .content');
  }

  function toggleVoice() {
    if (!Voice.supported) {
      alert('這個瀏覽器不支援語音輸入。\n請用 Chrome 或 Edge 開啟本工具。');
      return;
    }
    if (Voice.running) { Voice.stop(); return; }
    var root = currentTextRoot();
    root.focus();
    // 把游標放到內容最後
    var r = document.createRange(); r.selectNodeContents(root); r.collapse(false);
    var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    Voice.target = root;
    Voice.start(root);
  }

  Voice.onFinal = function (t) {
    var root = (Voice.target && document.contains(Voice.target)) ? Voice.target : currentTextRoot();
    Voice.target = root;
    Editor.insertTextAt(root, t);
    root.dispatchEvent(new Event('input'));
    $('#voiceText').textContent = '聆聽中…';
  };
  Voice.onInterim = function (t) {
    $('#voiceText').textContent = t ? t : '聆聽中…';
  };
  Voice.onState = function (st, msg) {
    var on = st === 'on';
    $('#voicebar').hidden = !on;
    $('#btnMic').classList.toggle('on', on);
    $('#btnMic').textContent = on ? '🎙️ 停止' : '🎙️ 語音';
    if (st === 'error' && msg) alert(msg);
  };
  $('#btnMic').addEventListener('click', toggleVoice);
  $('#btnVoiceStop').addEventListener('click', function () { Voice.stop(); });

  /* 語音列裡的標點模式 */
  (function () {
    var lab = document.createElement('label');
    lab.className = 'punct-pick';
    lab.innerHTML = '標點 <select id="selPunct">' +
      '<option value="auto">自動斷句</option>' +
      '<option value="spoken">只認說出來的</option>' +
      '<option value="off">不加標點</option>' +
      '</select>';
    $('#voicebar').insertBefore(lab, $('#btnVoiceStop'));
    var sel = $('#selPunct');
    sel.value = Voice.punctMode;
    sel.title = '自動斷句：依你講話的停頓自動補上，。？，同時也認「逗號／句號」等說出來的標點\n' +
      '只認說出來的：停頓不加標點，只有你說「逗號／句號／問號／換行」時才加\n' +
      '不加標點：完全照原樣輸出';
    sel.addEventListener('change', function () { Voice.setPunctMode(sel.value); });
  })();

  /* ============================================================
     彈窗
     ============================================================ */
  function openModal(title, bodyHTML, footNodes) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHTML || '';
    var foot = $('#modalFoot');
    foot.innerHTML = '';
    (footNodes || []).forEach(function (n) { foot.appendChild(n); });
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('pointerdown', function (e) { if (e.target.id === 'modal') closeModal(); });

  /**
   * 用 modal 取代瀏覽器的 prompt()（sandboxed 環境不支援 prompt）
   * 返回 Promise<string|null>
   */
  function promptModal(title, defaultValue) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'txt';
      input.value = defaultValue || '';
      input.style.cssText = 'width:100%;padding:8px;font-size:14px;border:1px solid #ccc;border-radius:4px;';

      var resolved = false;

      var okBtn = btn('確定', '', function () {
        resolved = true;
        closeModal();
        resolve(input.value || null);
      });
      var cancelBtn = btn('取消', '', function () {
        resolved = true;
        closeModal();
        resolve(null);
      });

      input.addEventListener('keypress', function (e) {
        if (e.key === 'Enter' && !resolved) {
          resolved = true;
          closeModal();
          resolve(input.value || null);
        }
      });

      openModal(title, '', [okBtn, cancelBtn]);
      $('#modalBody').innerHTML = '';
      $('#modalBody').appendChild(input);
      input.focus();
      input.select();
    });
  }

  /**
   * 用 modal 取代瀏覽器的 confirm()（sandboxed 環境不支援 confirm）
   * 返回 Promise<boolean>
   */
  function confirmModal(message) {
    return new Promise(function (resolve) {
      var okBtn = btn('確定', '', function () {
        closeModal();
        resolve(true);
      });
      var cancelBtn = btn('取消', '', function () {
        closeModal();
        resolve(false);
      });

      openModal('確認', message, [okBtn, cancelBtn]);
    });
  }

  function btn(label, cls, fn) {
    var b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  /* ============================================================
     手動出題 Alt+Q
     ============================================================ */
  function manualCard() {
    var sel = Editor.selectionText().trim();
    if (!sel) { alert('請先選取要當「答案」的文字，再按 Alt+Q。'); return; }
    var root = Editor.currentRoot();
    var blockEl = root && root.closest('.block');
    promptModal('請輸入題目', '請說明：' + sel.slice(0, 14)).then(function (q) {
      if (q === null) return;
      q = q.trim();
      if (!q) return;
      note.cards.push(M.newCard({
        type: 'manual', q: q, a: sel, blockId: blockEl ? blockEl.dataset.id : '', src: 'manual'
      }));
      markDirty();
      toast('已加入題庫：' + q);
    });
  }

  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:78px;transform:translateX(-50%);' +
        'background:#3B3A36;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;z-index:1200;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.25);transition:opacity .25s;pointer-events:none;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(function () { toastEl.style.opacity = '0'; }, 2200);
  }

  /* ============================================================
     題庫管理（刪掉出錯或不想要的題目）
     ============================================================ */
  function openCardManager(n) {
    Store.get(n.id).then(function (full) {
      if (!full) return;
      var cards = full.cards || [];

      function body() {
        if (!cards.length) {
          return '<div class="empty">這份筆記還沒有題目。<br><br>' +
            '用螢光筆標記重點後，按「📝 產生考題」加進題庫。</div>';
        }
        return '<div class="qlist">' + cards.map(function (c, i) {
          return '<div class="qitem" data-i="' + i + '">' +
            '<div class="q"><span class="tag">' + Quiz.label(c.type) + '</span>' + Quiz.renderQ(c.q) + '</div>' +
            '<div class="a">✓ ' + Quiz.renderQ(c.a) + '</div>' +
            '<div class="row"><span style="font-size:11px;color:#8A8680;margin-right:auto">熟練度 ' +
            (c.box || 0) + '/4</span>' +
            '<button class="btn btn-sm btn-ghost" data-a="del">🗑 刪掉這題</button></div></div>';
        }).join('') + '</div>';
      }

      function bind() {
        $$('#modalBody [data-a="del"]').forEach(function (b) {
          b.addEventListener('click', function () {
            var i = +b.closest('.qitem').dataset.i;
            cards.splice(i, 1);
            full.cards = cards;
            full.updatedAt = Date.now();
            Store.put(full).then(function () {
              if (note && note.id === full.id) note.cards = cards;
              var k = notes.findIndex(function (x) { return x.id === full.id; });
              if (k >= 0) notes[k] = full;
              $('#modalBody').innerHTML = body();
              bind();
              $('#cardCount').textContent = cards.length + ' 題';
              renderList();
            });
          });
        });
      }

      var count = document.createElement('span');
      count.id = 'cardCount';
      count.style.cssText = 'font-size:12px;color:#8A8680;margin-right:auto';
      count.textContent = cards.length + ' 題';

      openModal('🗂 題庫：' + (full.title || '未命名筆記'), body(),
        [count, btn('關閉', 'btn-primary', closeModal)]);
      bind();
    });
  }

  /* ============================================================
     產生考題
     ============================================================ */
  function openGenerator() {
    var drafts = Quiz.generate(note, { colon: true });
    var keep = {};
    drafts.forEach(function (c) { keep[c.id] = true; });

    function body() {
      var warn = '';
      if (drafts.skipped && drafts.skipped.length) {
        warn = '<div style="background:#FFF4E0;border:1px solid #F0D9A8;border-radius:8px;' +
          'padding:10px 12px;font-size:12.5px;line-height:1.75;color:#6B6660;margin-bottom:12px">' +
          '⚠️ 有 ' + drafts.skipped.length + ' 個標記把<b>整行都標起來了</b>，' +
          '挖空之後沒有剩下任何提示，所以沒有出題：<br>' +
          drafts.skipped.map(function (t) {
            return '「' + esc(t.length > 20 ? t.slice(0, 20) + '…' : t) + '」';
          }).join('、') +
          '<br>請<b>只標要考的那幾個字</b>，其他字留在外面當題目線索。' +
          '例如「slash 衝突」只標 <b>slash</b>，題目就會變成「＿＿＿ 衝突」。</div>';
      }
      if (drafts.blanks) {
        warn += '<div style="background:#FFF4E0;border:1px solid #F0D9A8;border-radius:8px;' +
          'padding:10px 12px;font-size:12.5px;line-height:1.75;color:#6B6660;margin-bottom:12px">' +
          '⚠️ 有 ' + drafts.blanks + ' 個標記標在 <b>______</b> 這串底線上，沒有出題。<br>' +
          '底線只是「這裡有空格」的記號，把它標起來的話，答案就會變成底線本身，' +
          '複習時永遠答不對。<br>' +
          '請<b>先把 ______ 換成答案</b>再標記 —— ' +
          '在筆記裡<b>對 ______ 點兩下</b>就會跳出來讓你直接填。</div>';
      }
      if (!drafts.length) {
        return warn + '<div class="empty">還沒有可以出題的內容。<br><br>' +
          '用<b>螢光筆</b>標記重點（選取文字後按 <kbd>Alt</kbd>+<kbd>1~5</kbd>），<br>' +
          '或在文字裡寫成「名詞：解釋」的格式，<br>' +
          '或幫圖片加上圖說，再回來產生考題。</div>';
      }
      return warn + '<div class="qlist">' + drafts.map(function (c) {
        return '<div class="qitem' + (keep[c.id] ? '' : ' off') + '" data-id="' + c.id + '">' +
          '<div class="q"><span class="tag">' + Quiz.label(c.type) + '</span>' + Quiz.renderQ(c.q) + '</div>' +
          '<div class="a">✓ ' + Quiz.renderQ(c.a) + '</div>' +
          '<div class="row"><button class="btn btn-sm btn-ghost" data-a="toggle">' +
          (keep[c.id] ? '不要這題' : '加回來') + '</button></div></div>';
      }).join('') + '</div>';
    }

    function refresh() {
      $('#modalBody').innerHTML = body();
      bind();
      $('#genCount').textContent = '選取 ' + Object.keys(keep).filter(function (k) { return keep[k]; }).length + ' 題';
    }
    function bind() {
      $$('#modalBody [data-a="toggle"]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.closest('.qitem').dataset.id;
          keep[id] = !keep[id];
          refresh();
        });
      });
    }

    var count = document.createElement('span');
    count.id = 'genCount';
    count.style.cssText = 'font-size:12px;color:#8A8680;margin-right:auto';

    openModal('📝 自動產生的考題（' + drafts.length + ' 題）', body(), [
      count,
      btn('複製提示給 AI 出更難的題', 'btn-sm', function () {
        navigator.clipboard.writeText(Quiz.aiPrompt(note)).then(function () {
          toast('已複製！貼到 Claude／ChatGPT，把回來的 JSON 用「貼上 AI 題目」匯入');
        }, function () { showPrompt(); });
      }),
      btn('貼上 AI 題目', 'btn-sm', openImport),
      btn('加入題庫', 'btn-primary', function () {
        var added = 0;
        drafts.forEach(function (c) { if (keep[c.id]) { note.cards.push(c); added++; } });
        markDirty();
        closeModal();
        toast('已加入 ' + added + ' 題，共 ' + note.cards.length + ' 題');
      })
    ]);
    bind();
    count.textContent = '選取 ' + drafts.length + ' 題';
  }

  function showPrompt() {
    openModal('複製這段給 AI', '<textarea class="ta" style="min-height:260px" id="promptTa"></textarea>', [
      btn('關閉', '', closeModal)
    ]);
    $('#promptTa').value = Quiz.aiPrompt(note);
    $('#promptTa').select();
  }

  function openImport() {
    openModal('貼上 AI 產生的題目（JSON）',
      '<p style="font-size:13px;color:#8A8680;margin:0 0 8px">把 AI 回覆的 JSON 整段貼進來即可，格式：' +
      '<code>[{"type":"qa","q":"…","a":"…"}]</code></p>' +
      '<textarea class="ta" id="impTa" placeholder="[ { &quot;q&quot;: … } ]"></textarea>', [
      btn('匯入', 'btn-primary', function () {
        var cards = Quiz.parseImport($('#impTa').value);
        if (!cards || !cards.length) { alert('看不懂這段內容，請確認是 JSON 陣列。'); return; }
        cards.forEach(function (c) { note.cards.push(c); });
        markDirty();
        closeModal();
        toast('已匯入 ' + cards.length + ' 題');
      })
    ]);
  }

  $('#btnMakeQuiz').addEventListener('click', function () { if (note) openGenerator(); });

  /* ============================================================
     複習
     ============================================================ */
  function startReview(pool) {
    if (saveTimer) { clearTimeout(saveTimer); save(); }
    pool = (pool || []).filter(Boolean);
    if (!pool.length) return;
    Promise.all(pool.map(function (n) { return n.id === (note && note.id) ? Promise.resolve(note) : Store.get(n.id); }))
      .then(function (full) {
        var queue = Quiz.buildQueue(full, true);
        if (!queue.length) {
          var total = Quiz.buildQueue(full, false);
          if (!total.length) {
            openModal('🧠 複習', '<div class="empty">題庫是空的。<br>先用螢光筆標記重點，再按「📝 產生考題」。</div>',
              [btn('好', 'btn-primary', closeModal)]);
            return;
          }
          openModal('🧠 複習', '<div class="empty">太棒了，今天沒有到期的題目！<br><br>共 ' + total.length +
            ' 題在排程中。</div>', [
            btn('還是要全部複習一遍', 'btn-primary', function () { runQueue(total, full); })
          ]);
          return;
        }
        runQueue(queue, full);
      });
  }

  function runQueue(queue, fullNotes) {
    var i = 0, right = 0, dirty = {};
    var stage = { reveal: null, grade: null };

    function keyHandler(e) {
      if ($('#modal').hidden) { document.removeEventListener('keydown', keyHandler); return; }
      var ans = $('#ansBox');
      if (!ans) return;
      /* 還在作答：鍵盤全部留給輸入框。
         空白鍵要能打出「office worker」的空格，數字鍵也要能打。
         送出由輸入框自己的 Enter 處理。 */
      if (ans.hidden) return;
      /* 答案已經顯示出來了，這時 1／2／3 才是評分 */
      if (/^Digit[123]$/.test(e.code) && stage.grade) {
        e.preventDefault();
        stage.grade(+e.code.slice(5) - 1);
      }
    }
    document.addEventListener('keydown', keyHandler);

    function finishUp() {
      document.removeEventListener('keydown', keyHandler);
      var ids = Object.keys(dirty);
      var chain = Promise.resolve();
      fullNotes.forEach(function (n) {
        if (!dirty[n.id]) return;
        chain = chain.then(function () {
          if (note && n.id === note.id) { note.cards = n.cards; return Store.put(note); }
          return Store.put(n);
        });
      });
      return chain.then(function () { return Store.all(); }).then(function (list) {
        notes = list;
        renderList();
      });
    }

    function step() {
      if (i >= queue.length) {
        finishUp().then(function () {
          openModal('🎉 複習完成', '<div class="card-stage"><div class="card-q">答對 ' + right + ' / ' + queue.length + '</div>' +
            '<div style="color:#8A8680;font-size:13px">答錯的題目會在今天稍後再出現；答對的會依 1／3／7／16 天的間隔排程。</div></div>',
            [btn('完成', 'btn-primary', closeModal)]);
        });
        return;
      }
      var item = queue[i];
      var c = item.card;
      var srcHTML = '';
      var n = fullNotes.filter(function (x) { return x.id === item.noteId; })[0];
      if (n && c.blockId) {
        var blk = (n.blocks || []).filter(function (b) { return b.id === c.blockId; })[0];
        if (blk && blk.type === 'image') srcHTML = '<div class="card-src">來自：' + esc(item.noteTitle) + '<img src="' + blk.src + '"></div>';
      }
      if (!srcHTML) srcHTML = '<div class="card-src">來自：' + esc(item.noteTitle) + ' · ' + Quiz.label(c.type) +
        ' · 熟練度 ' + c.box + '/4</div>';

      var userInput = '';
      var revealed = false;

      var contentHTML = '<div class="progress"><i style="width:' + (i / queue.length * 100) + '%"></i></div>' +
        '<div class="card-stage">' +
        '<div class="card-q">' + Quiz.renderQ(c.q) + '</div>' +
        '<div id="inputBox" style="margin:12px 0;"><input id="userAns" type="text" ' +
        'placeholder="在這裡作答，按 Enter 送出（不會的話直接按 Enter 看答案）" ' +
        'style="width:100%;padding:8px;font-size:14px;border:1px solid #ccc;border-radius:4px;"></div>' +
        '<div id="ansBox" hidden><div class="card-a" style="color:#2ecc71;margin:12px 0;"><strong>✓ 正確答案：</strong><br>' + Quiz.renderQ(c.a) + '</div><div id="feedback" style="color:#8A8680;font-size:13px;"></div></div>' +
        srcHTML + '</div>';

      openModal('🧠 複習（' + (i + 1) + ' / ' + queue.length + '）', contentHTML,
        [btn('送出（Enter）', 'btn-primary', function () { checkAnswer(); })]);

      var inputEl = $('#userAns');
      if (inputEl) {
        inputEl.focus();
        inputEl.addEventListener('keydown', function (e) {
          /* 只有 Enter 才送出。空白鍵、數字鍵都要留給使用者打字
             （答案可能是「office worker」或含數字） */
          if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
          else e.stopPropagation();
        });
      }

      stage.reveal = checkAnswer;
      stage.grade = grade;

      function checkAnswer() {
        if (revealed) return;
        userInput = (inputEl.value || '').trim();
        var correct = normalizeAnswer(c.a);
        var userAns = normalizeAnswer(userInput);

        $('#ansBox').hidden = false;
        if (inputEl) inputEl.style.display = 'none';

        var feedback = $('#feedback');
        if (userAns) {
          if (userAns === correct || userAns.indexOf(correct) >= 0) {
            /* 完全一樣，或是你多寫了一些鋪陳但把答案包在裡面 */
            feedback.textContent = '✓ 答對了！';
            feedback.style.color = '#2ecc71';
          } else if (isEssayAnswer(c.a)) {
            /* 一整段說明沒辦法用字串比對判對錯 —— 你講的可能是對的，
               只是用字跟範例答案不同。所以不下判定，改成把你答到的地方
               在正確答案裡標起來，讓你自己看一眼就知道漏了什麼。 */
            $('.card-a', $('#ansBox')).innerHTML = coverageHTML(String(c.a), userInput);
            feedback.innerHTML = '<strong>這題請自己對照評分</strong><br>' +
              '答案是一整段說明，沒辦法自動判對錯。<br>' +
              '<span style="color:#8A8680">你寫到的部分已經在上面<mark class="cov">標起來</mark>了。</span>' +
              '<br><span style="color:#8A8680">你的答案：' + esc(userInput) + '</span>';
            feedback.style.color = '#6B6660';
          } else {
            feedback.innerHTML = '<strong>✗ 答錯了</strong><br>你的答案：' + esc(userInput);
            feedback.style.color = '#e74c3c';
          }
        }

        revealed = true;
        var foot = $('#modalFoot');
        foot.innerHTML = '';
        var row = document.createElement('div');
        row.className = 'rate-row';
        row.style.width = '100%';
        [['😵 不熟（1）', 0, 'btn-danger'], ['🤔 普通（2）', 1, ''], ['😎 很熟（3）', 2, 'btn-good']].forEach(function (g) {
          row.appendChild(btn(g[0], g[1] === 2 ? 'btn-good' : g[2], function () { grade(g[1]); }));
        });
        foot.appendChild(row);
      }

      function normalizeAnswer(text) {
        // 標準化答案：去除空白、符號，轉小寫
        return (text || '').toLowerCase().replace(/\s+/g, '').replace(/[，。！？；：]/g, '');
      }

      /**
       * 這個答案是「一段說明」還是「一個詞」？
       * 說明類的（尤其是 AI 出的題）常常附帶舉例，用字千百種，
       * 字串比對一定判錯，所以不該下判定。
       */
      function isEssayAnswer(a) {
        var t = String(a || '').trim();
        return t.length > 20 || /[。；;]/.test(t) || t.split(/\s+/).length > 5;
      }

      /**
       * 把使用者答案裡出現過的字詞，在正確答案上標出來。
       * 純粹是字面比對，不猜同義詞 —— 只負責讓你一眼看出漏了哪些。
       */
      function coverageHTML(correct, user) {
        var toks = user.match(/[A-Za-z][A-Za-z'’-]+|[一-鿿]{2,}/g) || [];
        var lc = correct.toLowerCase();
        var hit = [];
        toks.forEach(function (t) {
          var s = t.toLowerCase();
          if (s.length < 2) return;
          var from = 0, k;
          while ((k = lc.indexOf(s, from)) >= 0) {
            for (var n = k; n < k + s.length; n++) hit[n] = true;
            from = k + s.length;
          }
        });
        var out = '', on = false;
        for (var i = 0; i < correct.length; i++) {
          var now = !!hit[i];
          if (now !== on) { out += now ? '<mark class="cov">' : '</mark>'; on = now; }
          out += esc(correct[i]);
        }
        if (on) out += '</mark>';
        return out.replace(/\n/g, '<br>');
      }

      function grade(g) {
        if (!revealed) checkAnswer();
        M.schedule(c, g);
        if (g > 0) right++;
        dirty[item.noteId] = true;
        i++;
        step();
      }
    }
    step();
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  $('#btnReview').addEventListener('click', function () { if (note) startReview([note]); });
  $('#btnReviewAll').addEventListener('click', function () { startReview(notes); });

  /* ============================================================
     備份 / 還原
     ============================================================ */
  $('#btnBackup').addEventListener('click', function () {
    openModal('備份 / 還原',
      '<p style="font-size:13px;color:#8A8680">所有筆記都存在這台電腦的瀏覽器裡。' +
      '建議定期匯出備份檔；換電腦或清除瀏覽器資料前一定要先匯出。</p>', [
      btn('⬇ 匯出全部筆記', 'btn-primary', function () {
        if (saveTimer) { clearTimeout(saveTimer); save(); }
        Promise.all([Store.all(), Store.folders()]).then(function (r) {
          var blob = new Blob([JSON.stringify({ v: 2, at: Date.now(), notes: r[0], folders: r[1] }, null, 1)],
            { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = '讀書筆記備份_' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        });
      }),
      btn('⬆ 匯入備份檔', '', function () {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json,application/json';
        inp.onchange = function () {
          var f = inp.files[0];
          if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var data = JSON.parse(fr.result);
              var list = data.notes || data;
              var fl = data.folders || [];
              if (!Array.isArray(list)) throw 0;
              confirmModal('要匯入 ' + list.length + ' 份筆記' +
                (fl.length ? '、' + fl.length + ' 個資料夾' : '') + '嗎？同 ID 的會被覆蓋。').then(function (ok) {
                if (!ok) return;
                Store.putMany(list)
                .then(function () { return fl.length ? Store.putFolders(fl) : null; })
                .then(function () { return Promise.all([Store.all(), Store.folders()]); })
                .then(function (r) {
                  notes = r[0]; folders = r[1];
                  renderList();
                  closeModal();
                  toast('已匯入 ' + list.length + ' 份筆記');
                });
              });
            } catch (e) { alert('檔案格式不正確。'); }
          };
          fr.readAsText(f);
        };
        inp.click();
      }),
      btn('🐞 診斷資訊', '', function () {
        openModal('🐞 診斷資訊',
          '<p style="font-size:12.5px;color:#8A8680">先在畫布上用筆和手指各寫一筆，' +
          '再回來打開這裡，然後把整個畫面截圖給我。</p>' +
          '<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;' +
          'line-height:1.7;background:#F7F4EF;border-radius:10px;padding:12px;margin:0">' +
          esc(diagText()) + '</pre>',
          [btn('關閉', 'btn-primary', closeModal)]);
      })
    ]);
  });

  /* ============================================================
     啟動
     ============================================================ */
  window.addEventListener('beforeunload', function () {
    if (saveTimer) { clearTimeout(saveTimer); save(); }
  });

  initTouchUI();
  keepStorage();

  /* 圖片轉文字要靠本機的 Python 伺服器。部署到靜態主機之後那個端點不存在，
     按鈕留著只會讓人按了出錯，所以要先判斷。
     先用網址判斷是不是本機／區網 —— 直接對靜態主機發探測請求的話，
     那個 404 會留一個紅色錯誤在 console 裡，看了以為壞掉。 */
  var LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|.+\.local|10\..+|192\.168\..+|172\.(1[6-9]|2\d|3[01])\..+)$/;
  if (!LOCAL_HOST.test(location.hostname)) {
    document.body.classList.add('no-ocr');
  } else {
    fetch('health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { document.body.classList.toggle('no-ocr', !(j && j.ocr)); })
      .catch(function () { document.body.classList.add('no-ocr'); });
  }

  Promise.all([Store.all(), Store.folders()]).then(function (r) {
    notes = r[0];
    folders = r[1];
    if (!notes.length) { newNote(); }
    else openNote(notes[0].id);
    renderList();
    syncToolbar();
    /* iOS Safari 的語音辨識不穩，與其給一個會壞的按鈕，
       不如告訴使用者按鍵盤上的聽寫鍵（系統內建，品質也比較好） */
    if (TOUCH && /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      $('#btnMic').title = 'iPad／iPhone 請改用鍵盤上的 🎤 聽寫鍵，辨識比較準也比較穩';
      $('#btnMic').style.opacity = '.5';
    } else if (!Voice.supported) {
      $('#btnMic').title = '這個瀏覽器不支援語音輸入，請改用 Chrome 或 Edge';
      $('#btnMic').style.opacity = '.5';
    }
  });
})();
