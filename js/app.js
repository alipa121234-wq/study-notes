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
    u.disabled = !Ink.canUndo() && !Editor.History.pick('undo') && blocksTopAt() < 0;
    r.disabled = !Ink.canRedo() && !Editor.History.pick('redo') && blocksRedoTopAt() < 0;
    u.style.opacity = u.disabled ? '.3' : '';
    r.style.opacity = r.disabled ? '.3' : '';
  }
  /* 區塊本身的新增／刪除／搬移也要能復原。
     原本只有筆跡和文字內容有紀錄，刪掉一整個圖片區或文字區之後按 ↶，
     它只會去復原文字，刪掉的區塊救不回來 —— 使用者反映這很不合理。
     刪除時整塊深拷貝起來（連筆跡、圖片一起），復原就是把它插回原本的位置。 */
  var blockHist = [], blockRedo = [];
  function pushBlockHist(entry) {
    entry.at = Date.now();
    blockHist.push(entry);
    if (blockHist.length > 100) blockHist.shift();
    blockRedo.length = 0;
    syncUndo();
  }
  function blocksTopAt() { var h = blockHist[blockHist.length - 1]; return h ? h.at : -1; }
  function blocksRedoTopAt() { var h = blockRedo[blockRedo.length - 1]; return h ? h.at : -1; }
  function blockIndex(id) {
    return (note.blocks || []).findIndex(function (x) { return x.id === id; });
  }
  function invertBlock(h, redo) {
    var arr = note.blocks;
    if (h.kind === 'move') {
      var to = redo ? h.to : h.from;
      var i = blockIndex(h.id);
      if (i >= 0) { var moved = arr.splice(i, 1)[0]; arr.splice(Math.max(0, Math.min(arr.length, to)), 0, moved); }
    } else {
      /* 新增的復原 = 移除；刪除的復原 = 插回去。重做則相反 */
      var add = (h.kind === 'del') !== !!redo;
      if (add) {
        if (blockIndex(h.block.id) < 0) arr.splice(Math.max(0, Math.min(arr.length, h.index)), 0, h.block);
      } else {
        var j = blockIndex(h.block.id);
        if (j >= 0) arr.splice(j, 1);
      }
    }
    renderBlocks();
    markDirty();
    syncUndo();
  }
  function undoBlock() { var h = blockHist.pop(); if (!h) return false; invertBlock(h, false); blockRedo.push(h); return true; }
  function redoBlock() { var h = blockRedo.pop(); if (!h) return false; invertBlock(h, true); blockHist.push(h); return true; }

  /* 工具列的 ↶ ↷（還有不在打字時的 Ctrl+Z）：筆跡、文字、區塊三種紀錄按時間排，
     復原「最後做的那件事」。iPad 沒有 Ctrl+Z，標錯顏色、刪錯區塊只能靠這顆按鈕。 */
  function doUndo() {
    var t = Editor.History.pick('undo');
    var c = [{ k: 'text', at: t ? t.at : -1 }, { k: 'ink', at: Ink.topAt() }, { k: 'block', at: blocksTopAt() }]
      .filter(function (x) { return x.at >= 0; })
      .sort(function (a, b) { return b.at - a.at; })[0];       // 最晚做的先復原
    if (!c) return;
    if (c.k === 'block') undoBlock();
    else if (c.k === 'text') Editor.History.undo(t.root);
    else Ink.undo(findBlock, rerenderCanvas);
    syncUndo();
  }
  function doRedo() {
    var t = Editor.History.pick('redo');
    var c = [{ k: 'text', at: t ? t.at : -1 }, { k: 'ink', at: Ink.redoTopAt() }, { k: 'block', at: blocksRedoTopAt() }]
      .filter(function (x) { return x.at >= 0; })
      .sort(function (a, b) { return a.at - b.at; })[0];       // 最早被復原的先重做
    if (!c) return;
    if (c.k === 'block') redoBlock();
    else if (c.k === 'text') Editor.History.redo(t.root);
    else Ink.redo(findBlock, rerenderCanvas);
    syncUndo();
  }
  Editor.History.onChange = syncUndo;

  /* 空的畫圖區顯示提示，畫上東西後隱藏 */
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
      $('.fold', el).textContent = '📁 ' + (f ? f.name : uncatName());
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
          /* 改名也是修改，沒有更新時間的話合併時會被判斷成「沒變」 */
          full.updatedAt = n.updatedAt = Date.now();
          if (note && note.id === n.id) note.updatedAt = full.updatedAt;
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
    var displayName = f ? f.name : (uncatName());
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
          f.name = name; f.updatedAt = Date.now();
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
      toast('已移到「' + (f ? f.name : uncatName()) + '」');
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
      label: uncatName(), dot: '#D8D2C8', on: !n.folderId,
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
        var currentName = f ? f.name : (uncatName());
        promptModal('資料夾名稱', currentName).then(function (name) {
          if (name === null) return;
          name = name.trim();
          if (!name) return;
          if (f) {
            f.name = name; f.updatedAt = Date.now();
            Store.putFolder(f).then(renderList);
          } else {
            // 改名「未分類」，存在 localStorage
            localStorage.setItem('sn_uncategorizedName', name);
            localStorage.setItem('sn_uncategorizedNameAt', String(Date.now()));   // 合併備份時比新舊
            renderList();
            toast('已改名為「' + name + '」');
          }
        });
      }
    });
    if (f) {
      items.push({
        label: '🎨 換顏色', dot: f.color, fn: function () {
          f.color = M.nextColor(f.color); f.updatedAt = Date.now();
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
                  full.folderId = null; full.updatedAt = Date.now();
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
    blockHist = []; blockRedo = [];     // 區塊紀錄屬於單一篇筆記
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
  /* 舊筆記裡可能已經夾著 \r（貼上 Windows 文字造成的），會多出空行。
     開啟時順手清掉，使用者不必自己一行一行刪。 */
  function healBlocks() {
    var fixed = 0;
    (note.blocks || []).forEach(function (b) {
      if (b.type === 'text' && b.html && b.html.indexOf('\r') >= 0) {
        b.html = b.html.replace(/\r/g, '');
        fixed++;
      }
    });
    if (fixed) markDirty();
    return fixed;
  }

  function renderBlocks() {
    healBlocks();
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
    /* 全部接上 DOM 之後立刻畫一次。不能只靠 buildBlock 裡的 rAF ——
       分頁在背景時 rAF 會被凍結，回到前景之前畫布是空的，
       看起來就像「這一塊壞掉了」。也不能在 buildBlock 裡直接畫，
       那時候元素還沒進文件，量不到尺寸。 */
    canvasMap.forEach(function (blk, cv) { Ink.render(cv, blk); });
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
      /* 有跳格的段落，間隔依內容而定；一般段落用 CSS 的預設 */
      if (b.tab) content.style.tabSize = b.tab + 'ch';
      syncTabWidth(content, b);
      Editor.History.track(content, b.id);
      var ph = function () { content.classList.toggle('ph', !content.textContent.trim()); };
      ph();
      content.addEventListener('input', function () {
        b.html = content.innerHTML;
        syncTabWidth(content, b);
        ph();
        markDirty();
      });
      content.addEventListener('focus', function () { selectedBlockId = b.id; });
      /* 對 OCR 產生的 ______ 點兩下 -> 直接填答案，填完自動上螢光筆 */
      content.addEventListener('dblclick', function (e) { fillBlank(e, content, b); });

      /* 文字段落也可以有格線和固定高度 —— 用觸控筆寫字時，
         空的段落只有一行高，沒有地方下筆。 */
      if (b.lined) content.classList.add('lined');
      if (b.h) {
        content.style.minHeight = b.h + 'px';
        content.style.resize = 'vertical';
        content.style.overflow = 'auto';
        var th = null;
        new ResizeObserver(function () {
          clearTimeout(th);
          th = setTimeout(function () {
            var nh = Math.round(content.getBoundingClientRect().height);
            if (nh && nh !== b.h) { b.h = nh; markDirty(); }
          }, 300);
        }).observe(content);
      }
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
      hint.innerHTML = '🎨 <b>畫圖區</b>　給算式、圖解、流程圖用，<b>保留筆跡原貌</b><br>' +
        '按工具列的 🖊️（或鍵盤 <b>B</b>）就能直接在這裡畫<br>' +
        '<span class="sk-sub">想寫出「文字」請按工具列的「✍️ 筆寫成字」 · ' +
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
    cv.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'pen') return;
      if (b.type === 'text' && Ink.mode === 'select') return;
      if (sessionStorage.getItem('sn_scribblehint')) return;
      sessionStorage.setItem('sn_scribblehint', '1');
      toast(b.type === 'sketch'
        ? '畫圖區保留筆跡原貌，不會變成文字。要文字請按工具列的「✍️ 筆寫成字」'
        : '想把手寫變成文字嗎？按工具列的「✍️ 筆寫成字」');
    }, true);

    wrap.appendChild(content);
    wrap.appendChild(cv);
    el.appendChild(wrap);

    if (b.type !== 'text') {
      var cap = document.createElement('input');
      cap.className = 'cap';
      cap.placeholder = b.type === 'image' ? '圖說（會拿來出考題，寫問句就變成看圖題）' : '這張圖在講什麼？（會拿來出考題）';
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
      (b.type === 'text' ? '<button data-a="paper" title="格線與高度（用觸控筆寫字時比較好寫）">📐</button>' : '') +
      '<button data-a="clearink" title="清除這塊的筆跡">🧹</button>' +
      '<button data-a="del" title="刪除區塊">🗑</button>';
    bar.addEventListener('click', function (e) {
      var a = e.target.dataset.a;
      if (!a) return;
      var i = note.blocks.indexOf(b);
      if (a === 'ocr') {
        popup(e.target, [
          { head: '表格／單字表（欄位用跳格對齊）' },
          { label: '中文為主（含英文）', fn: function () { ocrBlock(b, el, 'zh-Hant-TW', 'tab'); } },
          { label: '只有英文', fn: function () { ocrBlock(b, el, 'en-US', 'tab'); } },
          '-',
          { head: '填空題講義（空格補底線）' },
          { label: '中文為主（含英文）', fn: function () { ocrBlock(b, el, 'zh-Hant-TW', 'blank'); } },
          { label: '只有英文', fn: function () { ocrBlock(b, el, 'en-US', 'blank'); } }
        ]);
        return;
      }
      if (a === 'paper') {
        popup(e.target, [
          { head: '用觸控筆寫字時的版面' },
          {
            label: (b.lined ? '✓ ' : '') + '顯示格線', on: !!b.lined,
            fn: function () { b.lined = !b.lined; renderBlocks(); markDirty(); }
          },
          {
            label: b.h ? '恢復自動高度' : '加高，空出書寫空間', on: !!b.h,
            fn: function () { b.h = b.h ? 0 : 320; renderBlocks(); markDirty(); }
          }
        ]);
        return;
      }
      if (a === 'up' && i > 0) {
        note.blocks.splice(i, 1); note.blocks.splice(i - 1, 0, b);
        pushBlockHist({ kind: 'move', id: b.id, from: i, to: i - 1 });
        renderBlocks();
      }
      if (a === 'down' && i < note.blocks.length - 1) {
        note.blocks.splice(i, 1); note.blocks.splice(i + 1, 0, b);
        pushBlockHist({ kind: 'move', id: b.id, from: i, to: i + 1 });
        renderBlocks();
      }
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
          /* 先整塊深拷貝起來（連筆跡、圖片），按 ↶ 才救得回來 */
          var gone = note.blocks.indexOf(b);
          if (gone >= 0) pushBlockHist({ kind: 'del', block: JSON.parse(JSON.stringify(b)), index: gone });
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
  /* 只清空白，不能清跳格：跳格現在是表格欄位的分隔 */
  var CJK_GAP = new RegExp('([' + CJK + '])[ ]+(?=[' + CJK + '])', 'g');

  function tidyOcr(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(CJK_GAP, '$1')
      /* 行首的編號「1.」很常被認成小寫 L；英文裡沒有以「l.」開頭的句子 */
      .replace(/^l\.(?=\s)/gm, '1.')
      /* 講義上的小圖示（「同」的圓形底、項目符號）會被讀成圓圈符號，
         那不是內容，清掉。字母 o、O 不能碰 —— 分不出是圖示還是真的字 */
      .replace(/[○●◎〇⊙◐◑]/g, '')
      /* 圖示被讀成單獨一個 o、O 的也清掉（英文幾乎不會有單獨的 o），
         但黏在字上的（oadministrator）不能動，分不出哪個 o 是圖示 */
      .replace(/(^|\s)[oO](?=\s+[A-Za-z])/g, '$1')
      /* 英文單字中間冒出大寫（prOJect、tO）幾乎都是認錯，改回小寫；
         夾在字母裡的 0 是 o（t0 -> to）。開頭大寫的字（You、McDonald）不動。 */
      /* 0 要先換成 o，pr0Ject 才會變成 proJect、再被下一條改成小寫 */
      .replace(/\b([A-Za-z]+)0\b/g, '$1o')
      .replace(/([A-Za-z])0(?=[A-Za-z])/g, '$1o')
      .replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g, function (w) {
        /* iPhone、iPad、eBay 這種第二個字母大寫、後面又接小寫的是品牌寫法，不要動 */
        return /^[a-z][A-Z][a-z]{2,}$/.test(w) ? w : w.toLowerCase();
      })
      /* 填空底線後面接標點時不留空白。這裡只能比對「同一行」的空白，
         用 \s 會把換行一起吃掉，行尾的填空就會跟下一行黏在一起 */
      .replace(/______[ \t]+(?=[,.;:!?，。、；：！？])/g, '______')
      .replace(/ {2,}/g, ' ')
      /* 跳格前後的空白清掉。連續的跳格不能併：現在一個跳格就是一格，
         中間有空格子的列（例如標題的「最高級」沒讀到）併掉就整列往左擠 */
      .replace(/ *\t */g, '\t')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      /* 不能用 trim()：它會把跳格一起吃掉，表格第一列開頭的空欄位就不見了，
         整列往左擠（使用者那張表的「例句」跑到第一格） */
      .replace(/^[ \n]+|[ \n]+$/g, '');
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
  /**
   * @param gapMode 'tab'（預設）兩段文字之間空太多 -> 插入跳格，欄位會對齊；
   *                'blank' 補上 ______，給填空題講義用。
   *   表格的欄位之間本來就空很開，一律當成填空的話，每個欄位中間都會冒出
   *   ______（使用者遇到的狀況）。真正偵測到底線的地方不受這個選項影響。
   */
  /* 被 OCR 誤讀成「直書」的欄位拆回一個一個字。
     表格每一列都是同一句「準時完成專案」、字又剛好上下對齊時，
     Windows OCR 會把同一個位置的字由上往下串成一行（「完 準 完 準…」），
     整欄中文就亂掉了（使用者遇到的狀況）。ocr.ps1 對這種又高又窄的行
     會附上每個字自己的位置；如果這些字大多落在某一列橫排文字的高度內，
     就是誤讀，拆回單字、讓它們回到各自的列。真的直書文字旁邊不會剛好
     每個字都對到一列橫排文字，不受影響。 */
  function splitVerticalMisreads(lines) {
    var flat = lines.filter(function (l) { return !l.words && l.w > l.h; });
    var out = [];
    lines.forEach(function (l) {
      if (!l.words || l.words.length < 2) { out.push(l); return; }
      var hit = l.words.filter(function (w) {
        var c = w.y + w.h / 2;
        return flat.some(function (f) { return c >= f.y && c <= f.y + f.h; });
      }).length;
      if (hit >= l.words.length * 0.5) out.push.apply(out, l.words);
      else out.push(l);
    });
    return out;
  }

  /* 表格的格線、色塊邊緣被讀成的雜字（「一 三」「——」「… …」）。
     只由這些線條字組成的片段在表格模式直接丟掉；
     但單獨一個、高度跟一般字差不多的「丨」其實是英文的 I
     （使用者那張表的主詞 I 就被讀成丨）。比一般字高很多的是直的格線，照丟。 */
  var LINE_JUNK = /^[\s一二三口丨|｜—―ー\-_.…·~～]+$/;
  function dropLineJunk(lines) {
    var hs = lines.map(function (l) { return l.h; }).filter(function (v) { return v > 0; })
      .sort(function (a, b) { return a - b; });
    var medH = hs[Math.floor(hs.length / 2)] || 20;
    var out = [];
    lines.forEach(function (l) {
      var t = String(l.t || '').trim();
      if (!LINE_JUNK.test(t)) { out.push(l); return; }
      if (/^[丨|｜]$/.test(t) && l.h >= medH * 0.7 && l.h <= medH * 1.5) {
        out.push({ t: 'I', x: l.x, y: l.y, w: l.w, h: l.h });
      }
    });
    return out;
  }

  /**
   * 找表格的橫線（列與列之間的分隔線、標題色塊的上下緣）。
   * findUnderlines 是為填空題設計的：要夠深、長度以文字高為準、還會排除壓在
   * 文字底下的線，表格那種很淡又很長的框線它抓不到。
   * 這裡專門找「整列幾乎連在一起的有色像素」。
   * 為什麼需要它：一格裡有好幾行的時候（例句欄放英文句子和中文翻譯、
   * 或是一整塊說明），只有框線分得出哪幾行屬於同一列 —— 光看行距會把
   * 一列拆成好幾列（使用者那兩張 indicate、bid 的圖）。
   * @param cv    原始解析度的圖
   * @param scale 回傳座標要乘的倍率，好對上 OCR 的座標系
   */
  function findRules(cv, scale, vertical) {
    var w = cv.width, h = cv.height;
    if (!w || !h) return [];
    var d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    /* 直線就是把長寬對調來掃：外層走 x、內層走 y */
    var LEN = vertical ? h : w, CNT = vertical ? w : h;
    var at = function (a, b) { return vertical ? (b * w + a) * 4 : (a * w + b) * 4; };
    /* 表格線常常很淡（淺青、淺灰），門檻要放寬；線也常被文字或格子切斷，
       所以容許一段空白還算同一條。但這樣一來「夠長的一行文字」也可能被
       當成線，再加兩個條件擋掉：
         1. 整條幾乎都是有顏色的（文字行中間空隙多，密度不夠）
         2. 線很細（文字行會有十幾列都這麼長，線只有一兩列） */
    var need = LEN * 0.55, gapOk = Math.max(4, Math.round(LEN * 0.01));
    var hits = [], a, b, i, run, best, hole, ink;
    for (a = 0; a < CNT; a++) {
      run = 0; best = 0; hole = 0; ink = 0;
      for (b = 0; b < LEN; b++) {
        i = at(a, b);
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) {
          ink++; run += hole + 1; hole = 0;
          if (run > best) best = run;
        } else {
          hole++;
          if (hole > gapOk) { run = 0; hole = 0; }
        }
      }
      /* 兩種都算：
           細線 -> 連續一長條有色（中間允許一點斷）
           色塊 -> 整列有色的比例夠高。標題色塊上印著白字，白字會把連續的
                   線切斷，只看連續長度會把色塊誤判成上下兩塊，中間多一條
                   切線，同一列就被切成兩列（使用者那張字尾表的標題）。 */
      if ((best >= need && ink >= best * 0.8) || ink >= LEN * 0.75) hits.push(a);
    }
    var bands = [], cur = null;
    hits.forEach(function (v) {
      if (cur && v - cur.y2 <= 2) { cur.y2 = v; return; }
      cur = { y1: v, y2: v };
      bands.push(cur);
    });
    var out = [];
    bands.forEach(function (b) {
      var thick = b.y2 - b.y1;
      if (thick <= 5) {                       // 細線：一條分隔
        var m = (b.y1 + b.y2) / 2;
        out.push({ y1: m * scale, y2: m * scale });
        return;
      }
      if (thick > CNT * 0.5) return;          // 整張圖都這樣 = 底色，不是線
      out.push({ y1: b.y1 * scale, y2: b.y2 * scale });   // 色塊：上下緣各一條
    });
    return out;
  }

  function assembleOcr(lines, lead, gapMode, rules) {
    lines = splitVerticalMisreads(lines || []);
    if (gapMode !== 'blank') lines = dropLineJunk(lines);
    var items = lines.filter(function (l) {
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
    /* 同一列裡要依左緣排好。排序是先比垂直中心的，而中文框比英文框高一點、
       中心差個幾像素，同一列的欄位就會被排成「中文、第2欄、第3欄、第1欄」。
       後面抓欄位基準線是按順序取的，順序一亂，整張表就全部擠到同一欄。 */
    rows.forEach(function (r) {
      r.parts.sort(function (a, b) { return a.left - b.left; });
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

    /* ---- 表格模式：先找欄位基準線，再處理合併儲存格 ----
       用「每段文字的左緣」直接分群會錯：標題常常靠左或置中，起始位置跟
       內文不同，一錯位後面整張表都跟著偏（使用者遇到的狀況：標題在第 1 欄，
       good、bad 卻掉到第 2 欄，右邊還多出兩個空欄）。
       改成先看「欄位數最常見」的那幾列（例如四欄的列），取每一欄左緣的
       中位數當基準線，再把每段文字對到最近的基準線，並保持由左到右。
       合併儲存格（far 跨兩列）則限定「兩列都欄位不滿」才併，
       完整的列不會被錯併進去。 */
    if (gapMode !== 'blank') {
      var hs = rows.map(function (r) { return r.h; }).sort(function (a, b) { return a - b; });
      var medH = hs[Math.floor(hs.length / 2)] || 20;

      /* 欄位數要取「最多的那個」，不是「最常見的那個」。
         有合併儲存格的表格裡，被切開的那幾列只剩兩欄（farther/farthest），
         數量反而比完整的四欄列還多；取最常見的就會把整張表壓成兩欄，
         後面的欄位全部黏在一起（使用者遇到的偏格）。
         但也不能無條件取最大 —— 偶爾一列被辨識成多切一刀就會多出一欄，
         檢查方式見下面的 anchorsFor。 */
      /* 先把「同一格被切成兩段」接回去。
         OCR 有時候會把 latter（較後的）拆成 latter 和（較後的）兩段，
         直接拿去分欄的話，那一格就佔掉兩個欄位，整列往右擠一格
         （使用者遇到的狀況）。兩段之間空得比一個字還窄就是同一格，
         欄位之間的間隔都比這個寬得多。 */
      rows.forEach(function (r) {
        var segs = [], cur = null;
        r.parts.forEach(function (p) {
          if (cur && (p.left - cur.right) < r.h * 1.2) {
            /* 幾乎貼在一起的（latter 和它後面的括號）接起來不留空白 */
            /* 貼得很近就不留空白：latter 和後面的括號、被切成兩半的
               同一個字（fi + t -> fit）都要接回去，不能硬塞空白 */
            cur.t += ((p.left - cur.right) > r.h * 0.25 ? ' ' : '') + p.t;
            cur.right = Math.max(cur.right, p.right);
            return;
          }
          cur = { t: p.t, left: p.left, right: p.right };
          segs.push(cur);
        });
        r.segs = segs;
      });

      /* 有框線的話，先用框線把「視覺上的行」併成表格的列，再從列裡面分欄。
         欄位不能只看單獨一行：像字尾表那樣，「-ain」是跨兩列、垂直置中的，
         它幾乎不會跟別欄出現在同一行上，用行去統計就只認得出兩欄，
         整個字尾欄被塞進單字欄（使用者遇到的狀況）。
         併成列之後，一列裡本來就該看得到四欄。 */
      var bandedAlready = false;
      if (rules && rules.h && rules.h.length) {
        var cutList = [];
        rules.h.forEach(function (r) { cutList.push(r.y1, r.y2); });
        cutList.sort(function (a, b) { return a - b; });
        var bandNo = function (v) {
          var n = 0;
          for (var q = 0; q < cutList.length; q++) if (v > cutList[q]) n = q + 1;
          return n;
        };
        var byBand = {}, order = [];
        rows.forEach(function (r) {
          var k = bandNo((r.top + r.bot) / 2);
          if (!byBand[k]) { byBand[k] = { top: r.top, bot: r.bot, items: [] }; order.push(k); }
          byBand[k].top = Math.min(byBand[k].top, r.top);
          byBand[k].bot = Math.max(byBand[k].bot, r.bot);
          r.segs.forEach(function (sg) {
            byBand[k].items.push({ t: sg.t, left: sg.left, right: sg.right, top: r.top, bot: r.bot });
          });
        });
        var banded = order.map(function (k) {
          var bd = byBand[k];
          bd.items.sort(function (a, c) { return a.left - c.left; });
          var cols = [], cur = null;
          bd.items.forEach(function (it) {
            if (cur && it.left - cur.right < medH * 1.5) {     // 同一欄的上下行、同一行的相鄰片段
              cur.right = Math.max(cur.right, it.right);
              cur.parts.push(it);
              return;
            }
            cur = { left: it.left, right: it.right, parts: [it] };
            cols.push(cur);
          });
          cols.forEach(function (c) {
            c.parts.sort(function (a, d) { return (a.top - d.top) || (a.left - d.left); });
            /* 同一格的同一段文字被兩個版本各讀出一次（單字 -> 「0 0 宀」和
               「里子」），框的高度可能差很多；左右幾乎重疊、中心高度又差不到
               一個字，就是同一段，留框比較高的那個（通常讀得比較完整） */
            c.parts = c.parts.filter(function (pt, i) {
              var prev = c.parts[i - 1];
              if (!prev) return true;
              var ox = Math.min(pt.right, prev.right) - Math.max(pt.left, prev.left);
              var narrow = Math.min(pt.right - pt.left, prev.right - prev.left);
              var dy = Math.abs((pt.top + pt.bot) / 2 - (prev.top + prev.bot) / 2);
              var tall = Math.max(pt.bot - pt.top, prev.bot - prev.top);
              if (!(narrow > 0 && ox / narrow > 0.6 && dy < tall * 0.9)) return true;
              if (pt.bot - pt.top > prev.bot - prev.top) { prev.t = pt.t; }   // 留高的那個
              return false;
            });
            var width = c.right - c.left, out = '';
            c.parts.forEach(function (pt, i) {
              if (!i) { out = pt.t; return; }
              var prev = c.parts[i - 1];
              /* 上一行幾乎占滿整欄、下一行又是小寫開頭，而且上一行不是句號或
                 右括號結尾 -> 同一句被折行，用空白接；其餘都是另起一行 */
              var wrapped = (prev.right - prev.left) >= width * 0.6 &&
                /[A-Za-z0-9,]\s*$/.test(prev.t) &&      // 中文結尾的是另一行，不是折行
                /^[a-z0-9,.;:)]/.test(pt.t);
              out += (wrapped ? ' ' : '\u2028') + pt.t;
            });
            c.t = out;
          });
          return { segs: cols, top: bd.top, bot: bd.bot, h: medH, parts: bd.items };
        });
        if (banded.length >= 2) { rows = banded; bandedAlready = true; }
      }

      var counts = {};
      rows.forEach(function (r) {
        if (r.segs.length >= 2) counts[r.segs.length] = (counts[r.segs.length] || 0) + 1;
      });
      /* 只要有兩列以上就算數：像「主詞」那種跨很多列的合併儲存格，
         只會有幾列旁邊剛好有字，比例一定很低。
         為了不讓「某兩列多切了一刀」變成多一欄，算出來的基準線
         彼此至少要隔兩個字高，不然就退一步用比較少的欄位數。 */
      var anchorsFor = function (k) {
        var full = rows.filter(function (r) { return r.segs.length === k; });
        var a = [];
        for (var ci = 0; ci < k; ci++) {
          var xs = full.map(function (r) { return r.segs[ci].left; }).sort(function (x, y) { return x - y; });
          a.push(xs[Math.floor(xs.length / 2)]);
        }
        for (var q = 1; q < k; q++) if (a[q] - a[q - 1] < medH * 2) return null;
        return a;
      };
      var M = 0, anchors = null, vbounds = null;

      Object.keys(counts).map(Number).filter(function (k) {
        return k <= 12 && counts[k] >= 2;
      }).sort(function (x, y) { return y - x; }).some(function (k) {
        anchors = anchorsFor(k);
        if (anchors) M = k;
        return !!anchors;
      });

      /* 圖上有畫直線（欄與欄之間的分隔線）的話，拿來補統計的不足：
         使用者那張只有三列的字尾表樣本太少，統計猜成三欄、第三第四欄黏在
         一起，而直線是明明白白畫在圖上的。
         但直線不一定每一欄都有（助動詞表只在中間畫一條），所以只有在
         「直線分出來的欄位不比統計少」時才採用，並且丟掉完全沒有文字的欄。 */
      if (bandedAlready && rules && rules.v && rules.v.length) {
        var xs = [];
        rules.v.forEach(function (r) { xs.push((r.y1 + r.y2) / 2); });   // 直線的位置存在 y1/y2
        xs.sort(function (a, b) { return a - b; });
        /* 太靠邊的是外框，不是欄位分隔 */
        var lefts = [], rights = [];
        rows.forEach(function (r) {
          r.segs.forEach(function (sg) { lefts.push(sg.left); rights.push(sg.right); });
        });
        var minX = Math.min.apply(null, lefts), maxX = Math.max.apply(null, rights);
        var inner = xs.filter(function (v) { return v > minX && v < maxX; });
        /* 同一條線可能被偵測成相鄰好幾條，太近的併成一條 */
        var merged = [];
        inner.forEach(function (v) {
          if (merged.length && v - merged[merged.length - 1] < medH) return;
          merged.push(v);
        });
        /* 丟掉沒有任何文字的欄（偵測到的直線有時會多一條） */
        var used = function (lo, hi) {
          var n = 0;
          rows.forEach(function (r) {
            r.segs.forEach(function (sg) {
              var mid = (sg.left + sg.right) / 2;
              if (mid > lo && mid <= hi) n++;
            });
          });
          return n;
        };
        var keep = [];
        for (var vi = 0; vi < merged.length; vi++) {
          var lo = vi ? merged[vi - 1] : -Infinity;
          var hi = merged[vi];
          if (used(lo, hi)) keep.push(merged[vi]);
        }
        if (keep.length && !used(keep[keep.length - 1], Infinity)) keep.pop();
        if (keep.length >= 1 && keep.length <= 11 && keep.length + 1 >= M) {
          vbounds = keep;
          M = keep.length + 1;
          anchors = [minX].concat(keep);
        }
      }

      if (M >= 2) {
        var colOfX = function (x) {
          var n = 0;
          for (var i = 0; i < vbounds.length; i++) if (x > vbounds[i]) n = i + 1;
          return n;
        };
        var assign = function (segs) {
          var cells = [], right = [], next = 0;
          segs.forEach(function (pt) {
            var bi = next, bd = Infinity;
            if (vbounds) {
              bi = colOfX((pt.left + pt.right) / 2);
            } else {
              for (var i = next; i < M; i++) {
                var d = Math.abs(pt.left - anchors[i]);
                if (d < bd) { bd = d; bi = i; }
              }
            }
            cells[bi] = cells[bi] ? cells[bi] + ' ' + pt.t : pt.t;
            right[bi] = Math.max(right[bi] || 0, pt.right);
            next = Math.min(bi + 1, M - 1);
          });
          return { cells: cells, right: right };
        };
        var grid = rows.map(function (r) {
          var a = assign(r.segs);
          return { cells: a.cells, right: a.right, top: r.top, bot: r.bot };
        });
        var countCells = function (cells) {
          var n = 0;
          for (var i = 0; i < M; i++) if (cells[i] != null) n++;
          return n;
        };

        /* 一格裡有好幾行的欄位（例句欄放了英文句子和中文翻譯，長句子還會折行）。
           不處理的話，一個例句會被拆成三列，同一列的單字、詞性也跟著跑位
           （使用者那張 indicate 衍生字表）。
           認法：這種欄位的行數會比其他欄位多好幾倍。認出來之後整欄先抽走、
           依行距切成一塊一塊，剩下的行剛好每個表格列一行，分完列再把每一塊
           放回垂直位置對得上的那一列。
           一塊裡面：上一行如果快貼到欄位右邊，表示是同一句被折行，用空白接；
           否則是另起一行（英文句子換中文翻譯），用 \u2028 接，
           轉成表格時會變成 <br>。 */
        /* 有框線就用框線分列：兩條線之間的行都屬於同一列，
           同一欄有好幾行就接起來（上一行快貼到欄位右邊 = 同一句被折行，
           用空白接；否則另起一行，用 \u2028 接，轉成表格會變成 <br>）。 */
        var usedRules = bandedAlready;
        if (!bandedAlready && rules && rules.h && rules.h.length) {
          var cuts = [];
          rules.h.forEach(function (r) { cuts.push(r.y1, r.y2); });
          cuts.sort(function (a, b) { return a - b; });
          var bandOf = function (v) {
            var n = 0;
            for (var q = 0; q < cuts.length; q++) if (v > cuts[q]) n = q + 1;
            return n;
          };
          var colRight = [];
          grid.forEach(function (g) {
            for (var c4 = 0; c4 < M; c4++) colRight[c4] = Math.max(colRight[c4] || 0, g.right[c4] || 0);
          });
          var banded = [], prev = null;
          grid.forEach(function (g) {
            var b = bandOf((g.top + g.bot) / 2);
            if (prev && prev.band === b) {
              for (var c5 = 0; c5 < M; c5++) {
                if (g.cells[c5] == null) continue;
                if (prev.cells[c5] == null) { prev.cells[c5] = g.cells[c5]; }
                else {
                  /* 上一行貼到欄位右邊、下一行又是小寫開頭 = 同一句英文被折行，
                     用空白接。其他情況（下一行是中文翻譯、或像主詞那種一行一個字）
                     都是另起一行。 */
                  var wrapped = (prev.right[c5] || 0) >= (colRight[c5] || 0) - medH * 2.5 &&
                    /^[a-z0-9,.;:)]/.test(g.cells[c5]) &&
                    !/[)）。.!?！？」』]\s*$/.test(prev.cells[c5]);
                  prev.cells[c5] += (wrapped ? ' ' : '\u2028') + g.cells[c5];
                }
                prev.right[c5] = g.right[c5];
              }
              prev.bot = Math.max(prev.bot, g.bot);
              return;
            }
            g.band = b;
            banded.push(g);
            prev = g;
          });
          if (banded.length >= 1 && banded.length < grid.length) {
            grid = banded;
            usedRules = true;
          }
        }

        var wrapCol = -1, blocks = [];
        (function () {
          var count = [], med, i, c;
          for (c = 0; c < M; c++) count.push(0);
          grid.forEach(function (g) {
            for (c = 0; c < M; c++) if (g.cells[c] != null) count[c]++;
          });
          if (usedRules) return;            // 框線分得比猜的準
          med = count.slice().sort(function (a, b) { return a - b; })[Math.floor(M / 2)];
          for (c = 0; c < M; c++) if (count[c] >= 4 && count[c] > med * 1.5) wrapCol = c;
          if (wrapCol < 0) return;

          /* 先收集這一欄的每一行，還不要動 grid */
          var pieces = [], maxRight = 0;
          grid.forEach(function (g) {
            if (g.cells[wrapCol] == null) return;
            maxRight = Math.max(maxRight, g.right[wrapCol] || 0);
            pieces.push({ t: g.cells[wrapCol], right: g.right[wrapCol] || 0, top: g.top, bot: g.bot, g: g });
          });
          if (pieces.length < 3) { wrapCol = -1; return; }

          /* 同一格裡的行距，比列與列之間的間隔小很多。
             取所有間隔的中位數當「行距」，超過它 1.8 倍的就是換到下一列。
             用比例而不是固定值：不同大小的圖、不同行高都適用。 */
          var gaps = [];
          for (i = 1; i < pieces.length; i++) gaps.push(pieces[i].top - pieces[i - 1].bot);
          var sorted = gaps.slice().sort(function (a, b) { return a - b; });
          var medGap = sorted[Math.floor(sorted.length / 2)];
          var split = Math.max(medGap * 1.8, medH * 0.4);

          var cur = null;
          pieces.forEach(function (piece, k) {
            if (cur && gaps[k - 1] <= split) {
              cur.parts.push(piece);
              cur.bot = piece.bot;
            } else {
              cur = { parts: [piece], top: piece.top, bot: piece.bot };
              blocks.push(cur);
            }
          });
          /* 全部黏成一塊 = 判斷錯了，寧可不動 */
          if (blocks.length < 2) { wrapCol = -1; blocks = []; return; }

          blocks.forEach(function (b) {
            var out = '';
            b.parts.forEach(function (piece, k) {
              if (!k) { out = piece.t; return; }
              /* 上一行快貼到欄位右邊 = 同一句被折行，用空白接；
                 否則是另起一行（英文句子換中文翻譯），用 \u2028 接，
                 轉成表格時會變成 <br> */
              out += (b.parts[k - 1].right >= maxRight - medH * 2.5 ? ' ' : '\u2028') + piece.t;
            });
            b.text = out;
            b.parts.forEach(function (piece) { piece.g.cells[wrapCol] = null; });
          });
          grid = grid.filter(function (g) { return countCells(g.cells) > 0; });
        })();

        for (var gi = 0; gi < grid.length - 1; gi++) {
          var A = grid[gi], B = grid[gi + 1];
          var an = countCells(A.cells), bn = countCells(B.cells);
          var overlap = false;
          for (var cj = 0; cj < M; cj++) if (A.cells[cj] != null && B.cells[cj] != null) overlap = true;
          /* 兩列都「欄位不滿」、位置相鄰、占用的欄位又剛好互補 -> 合併儲存格 */
          if (!overlap && an && bn && an < M && bn < M && (B.top - A.bot) < medH * 1.2) {
            for (var ck = 0; ck < M; ck++) if (B.cells[ck] != null) A.cells[ck] = B.cells[ck];
            A.bot = B.bot;
            grid.splice(gi + 1, 1);
            gi--;
          }
        }

        /* 夾在兩列中間、又併不進任何一列的單一格，依序往下排。
           使用者那張助動詞表：主詞欄是一格跨十列，I You She He We They 直排
           在中間、行距比表格的列窄，You、We 就夾在兩列中間，各自變成一整列
           空著的列。把同一欄連續的這一串字依序排進各列，看起來就跟原圖一樣
           是直排的一串。
           只處理「夾在中間」的：它上下兩列的距離跟一般列距差不多。表格中間
           真的自己佔一列的小標題，會把上下兩列撐開，不受影響。 */
        var midOf = function (g) { return (g.top + g.bot) / 2; };
        var pgaps = [];
        for (var pq = 1; pq < grid.length; pq++) pgaps.push(midOf(grid[pq]) - midOf(grid[pq - 1]));
        pgaps.sort(function (a, b) { return a - b; });
        var pitch = pgaps[Math.floor(pgaps.length / 2)] || medH * 1.5;
        var orphan = grid.map(function (g, i) {
          if (i === 0 || i === grid.length - 1 || countCells(g.cells) !== 1) return -1;
          var c = 0;
          while (g.cells[c] == null) c++;
          var up = grid[i - 1], dn = grid[i + 1];
          if (up.cells[c] == null && dn.cells[c] == null) return -1;
          if (midOf(dn) - midOf(up) > pitch * 1.5) return -1;
          return c;
        });
        var dropRow = {};
        for (var oi = 0; oi < grid.length; oi++) {
          var oc = orphan[oi];
          if (oc < 0 || dropRow[oi]) continue;
          var s0 = oi;
          while (s0 > 0 && grid[s0 - 1].cells[oc] != null) s0--;
          var vals = [], e0 = s0;
          while (e0 < grid.length && grid[e0].cells[oc] != null) { vals.push(grid[e0].cells[oc]); e0++; }
          var targets = [];
          for (var ti = s0; ti < grid.length && targets.length < vals.length; ti++) {
            if (orphan[ti] === oc) continue;
            if (ti >= e0 && grid[ti].cells[oc] != null) break;
            targets.push(ti);
          }
          if (targets.length < vals.length) continue;       // 下面沒有足夠的空位就不動
          for (var tj = s0; tj < e0; tj++) {
            if (orphan[tj] === oc) dropRow[tj] = true;
            else grid[tj].cells[oc] = null;
          }
          targets.forEach(function (t, n) { grid[t].cells[oc] = vals[n]; });
          oi = e0 - 1;
        }
        grid = grid.filter(function (g, i) { return !dropRow[i]; });

        /* 多行欄位的每一塊，放回垂直位置重疊最多的那一列 */
        blocks.forEach(function (b) {
          var best = -1, bestOv = -Infinity;
          grid.forEach(function (g, i) {
            var ov = Math.min(g.bot, b.bot) - Math.max(g.top, b.top);
            if (ov > bestOv) { bestOv = ov; best = i; }
          });
          if (best < 0) return;
          var had = grid[best].cells[wrapCol];
          grid[best].cells[wrapCol] = had == null ? b.text : had + '\u2028' + b.text;
        });
        return grid.map(function (g) {
          var cells = [];
          for (var k = 0; k < M; k++) cells.push(g.cells[k] == null ? '' : g.cells[k]);
          while (cells.length && cells[cells.length - 1] === '') cells.pop();
          return cells.join('\t');
        }).join('\n');
      }
    }

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
      /* 表格模式不理會偵測到的橫線：表格的格線、標題色塊邊緣都會被判成底線，
         補成 ______ 就變成「標題列全是填空」。填空題模式才需要它們。 */
      var useLead = gapMode === 'blank' ? mine : [];
      var seq = row.parts.map(function (p) {
        return { left: p.left, right: p.right, t: p.t };
      }).concat(useLead.map(function (u) {
        return { left: u.x1, right: u.x2, t: null };
      })).sort(function (a, b) { return a.left - b.left; });

      var out = [], prev = null;
      seq.forEach(function (s) {
        if (s.t === null) {
          if (out[out.length - 1] !== OCR_BLANK) out.push(OCR_BLANK);
          return;
        }
        /* 兩段文字之間空太多：表格是欄位分隔（跳格對齊），
           填空題講義則是沒被偵測到的空格（補底線） */
        if (prev && out[out.length - 1] !== OCR_BLANK &&
          (s.left - prev.right) > row.h * 1.2) {
          out.push(gapMode === 'blank' ? OCR_BLANK : '\t');
        }
        out.push(s.t);
        prev = s;
      });
      /* 跳格前後不要再補空白，不然對齊會差一格 */
      return out.join(' ').replace(/ *\t */g, '\t');
    }).join('\n');
  }

  /* 跳格間隔：取「多數欄位」的寬度，不是最長的那一個。
     用最長的會被異常值毀掉 —— 辨識錯字、或某一列夾了一大段說明，
     間隔就被撐得很寬，四個欄位加起來超過一行，中文被擠到下一行。
     另外還要確定所有欄位塞得進這一塊的寬度。中文字算兩倍寬。 */
  function cellWidth(cell) {
    var w = 0;
    for (var i = 0; i < cell.length; i++) {
      w += /[\u3400-\u9fff\uf900-\uffef]/.test(cell.charAt(i)) ? 2 : 1;
    }
    return w;
  }
  function tabWidthFor(text, roomCols) {
    var T = String.fromCharCode(9), widths = [], cols = 0;
    String(text || '').split('\n').forEach(function (line) {
      if (line.indexOf(T) < 0) return;
      var cells = line.split(T);
      cols = Math.max(cols, cells.length);
      /* 每一列最後一欄後面沒有跳格，不影響間隔 */
      cells.slice(0, -1).forEach(function (c) { widths.push(cellWidth(c)); });
    });
    if (!widths.length) return 0;
    widths.sort(function (a, b) { return a - b; });
    var p80 = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.8))];
    var w = p80 + 2;
    if (roomCols && cols > 1) w = Math.min(w, Math.floor(roomCols / cols));
    return Math.max(5, Math.min(24, w));
  }

  /* 跳格間隔是「每一塊自己」的設定，依內容重算：
     只有轉出來的那一塊有設定的話，把文字複製到別的文字區就會退回預設寬度、
     欄位跟著跑掉。改成內容一變就重算。 */
  function syncTabWidth(content, b) {
    var T = String.fromCharCode(9);
    /* 一定要用 innerText：textContent 會忽略 <br>，整個表格會被當成「一行、
       幾十個欄位」，間隔就被壓到極小，欄位反而更亂。 */
    var txt = content.innerText || '';
    if (txt.indexOf(T) < 0) {
      if (b.tab) { delete b.tab; content.style.tabSize = ''; }
      return;
    }
    /* 這一塊實際容得下幾個字元，欄位才不會被擠到下一行 */
    var probe = document.createElement('span');
    probe.textContent = '00000000000000000000';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
    content.appendChild(probe);
    var chPx = probe.getBoundingClientRect().width / 20;
    probe.remove();
    var roomCols = chPx > 0 ? Math.floor(content.clientWidth / chPx) : 0;

    var w = tabWidthFor(txt, roomCols);
    if (w && w !== b.tab) {
      b.tab = w;
      content.style.tabSize = w + 'ch';
    }
  }

  function ocrBlock(b, el, lang, gapMode) {
    var el0 = $('img', el);
    if (!el0 || !el0.complete || !el0.naturalWidth) { toast('圖片還沒載入完，稍等一下再試'); return; }
    toast('辨識中…');
    /* 畫到 canvas 之前，瀏覽器會先套用圖片的色彩描述檔，淺色的字會被弄得更淡，
       OCR 就整格漏掉（使用者那張不規則動詞表整列的 fit）。
       改用 createImageBitmap 把色彩轉換關掉，同一張圖多讀到好幾格。
       不支援的瀏覽器就照舊用 <img>。 */
    var prep = (window.createImageBitmap && el0.src)
      ? fetch(el0.src).then(function (r) { return r.blob(); })
        .then(function (bl) { return createImageBitmap(bl, { colorSpaceConversion: 'none' }); })
        .catch(function () { return el0; })
      : Promise.resolve(el0);
    prep.then(function (img) { ocrRun(b, img, lang, gapMode); });
  }

  function ocrRun(b, img, lang, gapMode) {

    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    /* 放大倍率依圖片大小決定。字太小 OCR 就讀不準（使用者那張字尾表
       1600x371 放大 2 倍時「單字」讀成「里子」，放大 3 倍才讀得到），
       所以小圖多放大一點；但長長一條的表格（1600x2436）像素本來就多，
       維持 2 倍就好，放太大又慢又吃記憶體。最少要 2 倍：那張助動詞表
       不放大會整欄讀不到。再受記憶體與 Windows OCR 上限（邊長 1 萬）約束。 */
    var px = w * h;
    var f = px <= 1.2e6 ? 3 : 2;
    while (f > 1 && (px * f * f > 30e6 || Math.max(w, h) * f > 8000)) f--;

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
    ctx.fillStyle = '#fff';                    // 透明的截圖墊白底，不然透明處會被當成黑色
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    /* 同一張圖做幾個版本去辨識，再把結果合起來。單一版本一定會漏東西：
       - 淺藍、淺綠的字：轉灰階（取 RGB 最暗的通道）才讀得到；但淺色的格線、
         虛線也會跟著變深，被讀成「一」「——」，害整欄中文變成直書，
         所以原圖那份也要留著，由 pickOcr 挑比較好的當底。
       - 放大方式也會影響：平滑放大會把細筆畫糊掉，改用不平滑（最近鄰）放大，
         使用者那張不規則動詞表整列的 fit 才讀得出來。
       - 中文引擎對夾在中文表格裡的短英文字常常整格漏掉（fly、fit），
         英文引擎反而讀得到；英文引擎則完全讀不出中文，所以只拿它補洞、
         修英文錯字（fa Ⅱ -> fall）。
       全部同時送出，不會多等好幾倍時間。 */
    var gray = function (c) {
      var x = c.getContext('2d'), px = x.getImageData(0, 0, c.width, c.height), d = px.data;
      for (var i = 0; i < d.length; i += 4) {
        var m = d[i] < d[i + 1] ? d[i] : d[i + 1];
        if (d[i + 2] < m) m = d[i + 2];
        d[i] = d[i + 1] = d[i + 2] = m;
      }
      x.putImageData(px, 0, 0);
      return c;
    };
    var variant = function (smooth) {
      var c = document.createElement('canvas');
      c.width = w * f; c.height = h * f;
      var x = c.getContext('2d');
      x.imageSmoothingEnabled = smooth;
      if (smooth) x.imageSmoothingQuality = 'high';
      x.fillStyle = '#fff';                  // 透明的截圖墊白底，不然透明處會被當成黑色
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      return c;
    };

    /* 底線偵測的門檻是以文字高度為基準的，所以要等辨識結果回來才能算 */
    var leadFor = function (j) {
      var hs = (j.lines || []).map(function (l) { return l.h; })
        .filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
      var textH = hs.length ? hs[Math.floor(hs.length / 2)] / f : 0;
      return findUnderlines(src, f, textH);
    };
    var lead0 = function () { return []; };      // 判斷有沒有缺格時用不到底線

    var blobOf = function (c) {
      return new Promise(function (ok, fail) {
        c.toBlob(function (bl) { if (bl) ok(bl); else fail(new Error('圖片轉檔失敗')); }, 'image/png');
      });
    };
    var send = function (blob, useLang) {
      /* 用相對路徑：部署到 GitHub Pages 時網址帶子路徑，絕對路徑會指到根目錄 */
      return fetch('ocr?lang=' + encodeURIComponent(useLang || lang), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob
      }).then(function (r) {
        return r.json().catch(function () { throw new Error('伺服器沒有回應（HTTP ' + r.status + '）'); })
          .then(function (j) {
            if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
            return j;
          });
      });
    };
    var wantEn = lang.indexOf('zh') === 0;
    var soft = function (pr) { return pr.catch(function () { return null; }); };
    var counts = [];
    var rules = gapMode === 'blank' ? null
      : { h: findRules(src, f, false), v: findRules(src, f, true) };
    /* 一個一個做、做完就放掉，不要好幾張大圖同時留在記憶體裡 */
    var blobOfNew = function (smooth, toGray) {
      var c = variant(smooth);
      if (toGray) gray(c);
      return blobOf(c).then(function (bl) { c.width = c.height = 0; return bl; });
    };

    /* 先跑「原圖」和「平滑灰階」兩份就好，大部分的圖這樣就夠了。
       排成表格之後如果看起來有缺格，才再多跑兩份（不平滑灰階、英文引擎）。
       四份全跑：大張的表格要十秒，一般的圖六秒；只跑兩份大約一半。 */
    Promise.all([blobOfNew(true, false), blobOfNew(true, true)])
      .then(function (bl) { return Promise.all([send(bl[0]), soft(send(bl[1]))]); })
      .then(function (res) {
        counts = res.map(function (x) { return x ? x.lines.length : null; });
        /* 以「彩色原圖」那份為底，再用灰階補它漏掉的。灰階把淺色字變深、
           小圖也讀得多，但白字青底的標題會被它讀成垃圾（單字 -> 里子、
           詞性 -> 一0）；彩色原圖對這種黑字、正常對比的中文讀得最乾淨。
           所以中文以彩色為準，灰階只補彩色沒讀到的地方（淺藍字、被漏掉的格）。
           彩色那份萬一失敗才退回灰階。 */
        var j = res[0] || res[1];
        if (res[0] && res[1]) j = mergeOcr(res[0], res[1], false);
        if (!holesIn(j, lead0(), gapMode, rules)) return j;
        toast('有幾格沒讀到，再試一次…');
        return blobOfNew(false, true).then(function (bl2) {
          return Promise.all([soft(send(bl2)), wantEn ? soft(send(bl2, 'en-US')) : null]);
        }).then(function (more) {
          counts = counts.concat(more.map(function (x) { return x ? x.lines.length : null; }));
          if (more[0]) j = mergeOcr(j, more[0], false);   // 不平滑灰階：再補一次沒讀到的
          return mergeOcr(j, more[1], true);
        });
      }).then(function (j) {
      /* 轉出來怪怪的時候，可以在瀏覽器主控台看最後一次的辨識結果
         （每一行的文字和座標），不用重跑一次 */
      window.__lastOcr = {
        lines: j.lines, scale: f, size: [w, h], counts: counts, merged: j.lines.length,
        bitmap: (typeof ImageBitmap !== 'undefined') && (img instanceof ImageBitmap)
      };
      var text = tidyOcr(assembleOcr(j.lines, leadFor(j), gapMode, rules));
      if (!text) { toast('這張圖沒有辨識到文字'); return; }
      /* 英文錯字校正（oadministrator、fi t、-aln…）。字典載不到就原文照用 */
      return Spell.fix(text).then(function (r) {
        addTextAfter(b, r.text);   // 間隔由 syncTabWidth 依內容與寬度決定
        toast('已轉成 ' + r.text.split('\n').length + ' 行文字' +
          (gapMode === 'blank' ? '' : '，欄位用跳格對齊') +
          (r.count ? '，修正 ' + r.count + ' 個疑似錯字' : '') + ' —— 請先校對錯字再標記');
      });
    }).catch(function (e) {
      toast('辨識失敗：' + e.message);
    });
  }

  /**
   * 把另一份辨識結果併進來：同一個位置沒東西的才補，已經有的不動。
   * @param fromEn 另一份是英文引擎跑的 —— 除了補洞，還會用它修「整格都是英文、
   *               中文引擎卻讀出怪符號」的格子（fa Ⅱ -> fall）。
   *               中文格不會被動到：英文引擎根本讀不出中文，那些位置也早就有東西了。
   */
  function mergeOcr(base, extra, fromEn) {
    if (!extra || !extra.lines || !base || !base.lines) return base;
    var box = function (l) { return [l.x, l.y, l.x + l.w, l.y + l.h]; };
    var overlap = function (a, b) {
      var x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
      var x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
      if (x2 <= x1 || y2 <= y1) return 0;
      var small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
      return small ? (x2 - x1) * (y2 - y1) / small : 0;
    };
    var latin = function (t) { return (String(t).match(/[A-Za-z]/g) || []).length; };
    var clean = function (t) { return /^[A-Za-z0-9 ,.'\-]+$/.test(String(t).trim()); };
    /* 同一格在兩份裡被讀成不一樣的字（單字 -> 「0 0 宀」和「里子」），
       框只差幾個像素，要當成同一格，不然同一列會被拆成兩列 */
    var sameCell = function (a, b) {
      if (overlap(a, b) > 0.25) return true;
      /* 兩份讀到的框高度可能差很多（「0 0 宀」只框到上半部），重疊面積不夠看。
         左右幾乎完全重疊、中心高度又差不到一個字，就是同一格。 */
      var ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      var narrow = Math.min(a[2] - a[0], b[2] - b[0]);
      if (ox <= 0 || !narrow) return false;
      var cyA = (a[1] + a[3]) / 2, cyB = (b[1] + b[3]) / 2;
      var tall = Math.max(a[3] - a[1], b[3] - b[1]);
      return ox / narrow > 0.6 && Math.abs(cyA - cyB) < tall * 0.9;
    };
    var lines = base.lines.slice();
    (extra.lines || []).forEach(function (e) {
      if (fromEn && !latin(e.t)) return;                       // 英文引擎讀中文只會出垃圾
      var eb = box(e), hit = null;
      for (var i = 0; i < lines.length; i++) {
        if (sameCell(eb, box(lines[i]))) { hit = lines[i]; break; }
      }
      if (!hit) { lines.push(e); return; }
      if (!fromEn) return;
      /* 這一格本來就是英文，中文引擎卻讀出怪符號 -> 用英文引擎的 */
      var t = String(hit.t).trim(), stripped = t.replace(/\s/g, '');
      if (stripped && latin(t) >= stripped.length * 0.5 && !clean(t) && clean(e.t)) hit.t = e.t;
    });
    return { lines: lines };
  }

  /**
   * 這份辨識結果看起來有沒有「該有字卻空著」的格子。
   * 有的話才值得多跑幾個版本去補（每多一個版本就多等好幾秒）。
   * 整欄大多是空的不算 —— 那是跨很多列的合併儲存格（主詞欄），本來就該空著。
   */
  function holesIn(j, lead, gapMode, rules) {
    if (gapMode === 'blank') return false;               // 填空題講義沒有欄位可比
    var rows = tidyOcr(assembleOcr(j.lines, lead, gapMode, rules))
      .split(String.fromCharCode(10)).map(function (l) { return l.split(String.fromCharCode(9)); });
    var cols = 0;
    rows.forEach(function (r) { cols = Math.max(cols, r.length); });
    if (cols < 2 || rows.length < 3) return false;       // 不是表格就無從判斷
    var filled = [];
    for (var c = 0; c < cols; c++) {
      filled.push(rows.filter(function (r) { return (r[c] || '').trim(); }).length);
    }
    var holes = 0;
    rows.forEach(function (r) {
      for (var c = 0; c < cols; c++) {
        if (filled[c] < rows.length * 0.5) continue;     // 這一欄本來就大多是空的
        if (!(r[c] || '').trim()) holes++;
      }
    });
    return holes >= 2;
  }

  /* 原圖、灰階兩份辨識結果挑一個。
     先比「被誤讀成直書」的行（ocr.ps1 對又高又窄的行會附 words）誰少，
     這是最傷的錯誤，整欄中文會亂掉；平手再比讀到的字數，
     格線被讀成的「一」「—」「…」不算；再平手用原圖。 */
  function pickOcr(a, b) {
    if (!b) return a;
    var score = function (j) {
      var tall = 0, chars = 0;
      (j.lines || []).forEach(function (l) {
        if (l.words) tall++;
        chars += String(l.t || '').replace(/[\s一—―ー\-_.…·|｜]/g, '').length;
      });
      return { tall: tall, chars: chars };
    };
    var sa = score(a), sb = score(b);
    if (sa.tall !== sb.tall) return sa.tall < sb.tall ? a : b;
    return sb.chars > sa.chars ? b : a;
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
      Editor.History.checkpoint(root);
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
      root.dispatchEvent(new Event('input'));     // 更新 b.html、存檔、記進復原紀錄
      toast('已填入「' + ans + '」並標成挖空題');
    });
  }

  /* 把辨識結果排成真的表格。
     用跳格對齊有先天限制：某一格的字比一格寬時，後面的欄位會被推到下一格
     （farther（更遠的）後面的中文就會偏掉）；把間隔加寬到容得下最長的字，
     整列又會超過寬度、被擠到下一行。表格沒有這個問題：每一欄自動取最寬的
     內容當寬度，永遠對齊，視窗變窄也會自己調整。 */
  function ocrToHtml(text) {
    var T = String.fromCharCode(9);
    var lines = String(text || '').split('\n');
    var tabbed = lines.filter(function (l) { return l.indexOf(T) >= 0; }).length;
    /* 只有一行、但那一行有欄位分隔的，也是表格
       （整張圖就是一列的版面，例如左右各一塊的說明卡） */
    if (tabbed < 2 && !(tabbed === 1 && lines.length === 1)) {
      return esc(text).replace(/[\u2028\n]/g, '<br>');
    }
    var cols = 0;
    lines.forEach(function (l) { cols = Math.max(cols, l.split(T).length); });
    var body = lines.map(function (l) {
      if (!l.trim()) return '';
      var cells = l.split(T);
      /* 沒有跳格的行（例如表格前的說明）橫跨整列 */
      /* 同一格裡的換行（例句欄的英文句子、中文翻譯各一行） */
      var cell = function (v) { return esc(v == null ? '' : v).replace(/\u2028/g, '<br>'); };
      if (cells.length === 1) return '<tr><td colspan="' + cols + '">' + cell(l) + '</td></tr>';
      var tds = '';
      for (var i = 0; i < cols; i++) tds += '<td>' + cell(cells[i]) + '</td>';
      return '<tr>' + tds + '</tr>';
    }).join('');
    return '<table class="ocr-table">' + body + '</table>';
  }

  function addTextAfter(b, text, tab) {
    var i = note.blocks.indexOf(b);
    var nb = M.newBlock('text', { html: ocrToHtml(text) });
    if (tab) nb.tab = tab;                    // 這一塊自己的跳格間隔（單位：字元寬）
    note.blocks.splice(i + 1, 0, nb);
    pushBlockHist({ kind: 'add', block: nb, index: i + 1 });
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
    pushBlockHist({ kind: 'add', block: b, index: idx });
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
      if (!last) return;
      last.scrollIntoView({ block: 'center', behavior: 'smooth' });
      /* 圖片本身出不了考題，圖說才可以 —— 貼完直接把游標放進去，
         不然多半就忘了寫，那張圖等於白貼。 */
      var cap = $('.cap', last);
      if (cap) {
        setTimeout(function () {
          cap.focus();
          cap.classList.add('await-cap');
          setTimeout(function () { cap.classList.remove('await-cap'); }, 2500);
        }, 350);
      }
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
      /* 先看是不是表格：是的話保留欄位結構（過濾掉樣式與 script），
         不是就照舊只取純文字，避免從網頁夾帶一堆格式進來 */
      var clean = Editor.sanitizePaste(e.clipboardData.getData('text/html'));
      if (clean) {
        e.preventDefault();
        Editor.History.checkpoint(root);
        document.execCommand('insertHTML', false, clean);
        root.dispatchEvent(new Event('input'));
        return;
      }
      var txt = e.clipboardData.getData('text/plain');
      if (txt) {
        e.preventDefault();
        Editor.History.checkpoint(root);
        Editor.insertTextAt(root, txt);
        root.dispatchEvent(new Event('input'));
      }
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

    /* 用觸控筆寫出「文字」的條件有兩個，而且兩個都不直覺：
         1. 必須在選取模式 —— 畫筆模式下畫布會把筆攔走
         2. 必須寫在文字段落上 —— 畫圖區是畫布，iOS 眼中沒有文字輸入框
       期待使用者自己選中「🖱️ 選取」這個看起來完全不像寫字的工具是不合理的，
       所以給一顆按鈕一次把兩件事都準備好。 */
    $('#btnHandwrite').addEventListener('click', function () {
      Ink.setMode('select');
      var blocks = note.blocks || [];
      var target = null;
      for (var i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'text') { target = blocks[i]; break; }
      }
      if (!target) {
        target = M.newBlock('text');
        blocks.push(target);
        renderBlocks();
        markDirty();
      }
      var el = $('.block[data-id="' + target.id + '"] .content');
      if (!el) return;
      el.focus();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('await-pen');
      setTimeout(function () { el.classList.remove('await-pen'); }, 2500);
      toast('用觸控筆直接寫在這一塊上，iOS 會把它轉成文字');
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

    /* 用觸控筆寫字時的小鍵盤。
       手寫轉文字沒辦法輸入退格、空白、換行，為了刪一個字要叫出整個
       系統鍵盤太麻煩，所以在旁邊放三顆就好。 */
    var pad = $('#penpad');

    /* 標題是 <input>，內文是 contenteditable，兩者要分開處理 */
    function padTarget() {
      var a = document.activeElement;
      if (a === $('#noteTitle')) return a;
      return a && a.isContentEditable ? a : null;
    }

    function padAct(k) {
      var el = padTarget();
      if (!el) return;
      el.focus();

      if (el.tagName === 'INPUT') {
        var s = el.selectionStart, e = el.selectionEnd;
        if (k === 'back') {
          if (s !== e) el.setRangeText('', s, e, 'end');
          else if (s > 0) el.setRangeText('', s - 1, s, 'end');
          else return;
        } else if (k === 'tab') {
          return;                    // 標題只有一行，沒有對齊的需要
        } else if (k === 'space') {
          el.setRangeText(' ', s, e, 'end');
        } else {
          /* 單行的標題沒有「換行」可言，就當成「寫完了，跳到內文」 */
          var first = $('#blocks .tblock .content');
          if (first) { first.focus(); setTimeout(syncPad, 60); }
          return;
        }
      } else {
        if (k === 'back') document.execCommand('delete');
        else if (k === 'space') document.execCommand('insertText', false, ' ');
        else if (k === 'tab') document.execCommand('insertText', false, '\t');
        else document.execCommand('insertLineBreak');
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    Array.prototype.forEach.call(pad.querySelectorAll('button'), function (b) {
      onTap(b, function () { padAct(b.dataset.k); });
    });

    function syncPad() {
      var el = padTarget();
      var on = TOUCH && Ink.mode === 'select' && !!el;
      pad.hidden = !on;
      if (!on) return;
      var inTitle = el.tagName === 'INPUT';
      /* 標題的 ↵ 改成「跳到內文」，圖示不變但說明要對 */
      var ent = pad.querySelector('[data-k="enter"]');
      if (ent) ent.title = inTitle ? '寫完了，跳到內文' : '換行';
      /* 放在正在編輯那一塊的「上方、置中」，手才不會擋到自己寫的字 */
      var blk = inTitle ? el : (el.closest('.block') || el);
      var r = blk.getBoundingClientRect();
      var h = pad.offsetHeight || 56;
      var vv = window.visualViewport;
      var top = vv ? vv.offsetTop : 0;
      var bottom = top + (vv ? vv.height : innerHeight);
      var y = r.top - h - 10;
      /* 區塊頂端被工具列蓋住或捲出畫面時，改放在區塊下方 */
      if (y < top + 8) y = Math.min(bottom - h - 10, r.bottom + 10);
      pad.style.top = Math.max(top + 8, y) + 'px';
    }
    ['focusin', 'focusout', 'pointerup', 'touchend'].forEach(function (ev) {
      document.addEventListener(ev, function () { setTimeout(syncPad, 60); });
    });
    if (window.visualViewport) {
      ['resize', 'scroll'].forEach(function (ev) {
        window.visualViewport.addEventListener(ev, syncPad);
      });
    }

    /* 沒有實體鍵盤就按不出 Alt+1~5，改成選取文字後浮一排顏色出來 */
    var bar = $('#selbar');
    var savedRange = null;      // iOS 上點按鈕會把選取收掉，先存起來待會還原
    var LABEL = ['挖空填空', '名詞解釋', '易錯重點', '整句問答', '只標記'];

    /* 兩排：上排螢光筆（出題用）＋朗讀，下排文字顏色＋字級。
       一排塞不下，iPhone 寬度會被擠出畫面。 */
    var row1 = document.createElement('div'), row2 = document.createElement('div');
    row1.className = row2.className = 'sel-row';
    bar.appendChild(row1);
    bar.appendChild(row2);

    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.className = 'sw hl-' + n;
        b.title = LABEL[n - 1];
        b.textContent = n;
        onTap(b, function () { applySel('hl', n); });
        row1.appendChild(b);
      })(i);
    }
    var clr = document.createElement('button');
    clr.textContent = '✕';
    clr.title = '清除螢光筆和文字顏色';
    onTap(clr, function () { applySel('hl', 0); });
    row1.appendChild(clr);

    /* 文字顏色：原本只有鍵盤 Alt+Shift+1~5 能用，iPad 上沒有入口 */
    var FC_NAME = ['黑', '紅', '藍', '綠', '橘'];
    for (var j = 1; j <= 5; j++) {
      (function (n) {
        var b = document.createElement('button');
        b.className = 'fcA fc-' + n;
        b.title = '文字顏色：' + FC_NAME[n - 1];
        b.textContent = 'A';
        onTap(b, function () { applySel('fc', n); });
        row2.appendChild(b);
      })(j);
    }
    /* 字級：按了不收起浮動列、選取也留著，才能連按好幾下 */
    [['A−', -1, '字變小'], ['A+', 1, '字變大']].forEach(function (d, k) {
      var b = document.createElement('button');
      b.className = 'sz' + (k === 0 ? ' grp' : '');
      b.textContent = d[0];
      b.title = d[2] + '（桌機：Alt+' + (d[1] > 0 ? '=' : '-') + '）';
      onTap(b, function () { applySize(d[1]); });
      row2.appendChild(b);
    });
    /* 背單字最常想知道的就是「這個字怎麼念」。
       念完不收起色條、不動選取，方便馬上再按一次放慢念。 */
    if (window.Speak && Speak.supported) {
      var spk = document.createElement('button');
      spk.textContent = '🔊';
      spk.title = '朗讀（三秒內再按一次會放慢）';
      spk.className = 'grp';
      onTap(spk, function () { speakSelection(savedRange); });
      row1.appendChild(spk);
      var rep = document.createElement('button');
      rep.textContent = '🔁';
      rep.title = '重複播放（中英文都念，按停止才停）';
      onTap(rep, function () { loopSelection(savedRange); });
      row1.appendChild(rep);
    }

    /* 就算前面擋不住，這裡再把選取範圍放回去 —— 不然套用時
       選取是空的，按了完全沒反應（顏色不會出現） */
    function restoreSaved() {
      var sel = window.getSelection();
      if (savedRange && (!sel.rangeCount || sel.isCollapsed)) {
        try { sel.removeAllRanges(); sel.addRange(savedRange); } catch (e) { /* 已失效 */ }
      }
    }
    function applySize(delta) {
      restoreSaved();
      changeSize(delta);
      /* 包上新標籤後舊的範圍會失效，換成 mark() 重新選好的那個 */
      var s2 = window.getSelection();
      if (s2.rangeCount && !s2.isCollapsed) savedRange = s2.getRangeAt(0).cloneRange();
    }
    function applySel(kind, n) {
      restoreSaved();
      var root = Editor.currentRoot();
      if (root) Editor.History.checkpoint(root);
      if (n) Editor.mark(kind, n); else Editor.clearMarks();
      root = Editor.currentRoot() || root;
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
      syncPad();
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
  /* 「右邊那一條畫不上去」這種問題，關鍵是要知道指標事件到底有沒有送進來。
     把畫面橫向切成 20 格，分別統計：
       doc = 事件有送到網頁（不管落在哪個元素）
       ink = 事件確實送到筆跡畫布上
     兩個都是 0  -> iOS 根本沒把事件交給網頁（系統浮層蓋住了，我們改不了）
     doc 有、ink 是 0 -> 網頁裡有東西蓋在畫布上面（我們的版面問題）
     ink 有、卻畫不出來 -> 是繪圖邏輯的問題
     只做計數，不呼叫 elementFromPoint，不會拖慢畫圖。 */
  var ZN = 20;
  var zoneDoc = [], zoneInk = [];
  for (var zi = 0; zi < ZN; zi++) { zoneDoc.push(0); zoneInk.push(0); }
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      var k = Math.floor((e.clientX / innerWidth) * ZN);
      if (k >= 0 && k < ZN) zoneDoc[k]++;
      seqLog(e);
      if (e.target && e.target.classList && e.target.classList.contains('ink')) {
        if (k >= 0 && k < ZN) zoneInk[k]++;
        logEv(e);
      } else {
        /* 沒落在畫布上的那些事件才是關鍵 —— 筆跡每斷一次就對應這裡一筆。
           記下它被誰接走、在哪個位置。這種事件只占一成，記下來不影響效能。 */
        stealCount(e);
      }
    }, true);
  });

  /* 筆畫為什麼會斷：把「按下／放開／取消」按時間順序記下來，move 只記次數。
     如果每次筆的 up 之前都先出現一個 touch（手掌），那就是手掌觸發了
     瀏覽器手勢，而手勢一啟動瀏覽器就會取消所有進行中的指標。 */
  var seq = [], seqT0 = 0;
  function seqLog(e) {
    if (e.type === 'pointermove') {
      var l = seq[seq.length - 1];
      if (l && l.t === 'move' && l.p === e.pointerType) { l.n++; return; }
      seq.push({ t: 'move', p: e.pointerType, n: 1, ms: Date.now() });
    } else {
      if (!seqT0) seqT0 = Date.now();
      seq.push({
        t: e.type.replace('pointer', ''), p: e.pointerType, n: 0, ms: Date.now(),
        x: Math.round(e.clientX), y: Math.round(e.clientY),
        ink: !!(e.target && e.target.classList && e.target.classList.contains('ink'))
      });
    }
    if (seq.length > 34) seq.shift();
  }
  function seqText() {
    if (!seq.length) return '  （還沒有事件）';
    var t0 = seq[0].ms;
    return seq.map(function (s) {
      var head = '  +' + String(s.ms - t0).padStart(5) + 'ms  ' +
        (s.p === 'pen' ? '筆  ' : s.p === 'touch' ? '手掌' : '滑鼠') + ' ';
      if (s.t === 'move') return head + 'move ×' + s.n;
      return head + s.t.toUpperCase().padEnd(6) +
        ' (' + s.x + ',' + s.y + ')' + (s.ink ? ' 在畫布' : ' 不在畫布');
    }).join('\n');
  }

  var steals = {};
  function stealCount(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var name = el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    var s = steals[name];
    if (!s) s = steals[name] = { n: 0, x0: 9e9, x1: -9e9, y0: 9e9, y1: -9e9, types: {} };
    s.n++;
    s.x0 = Math.min(s.x0, e.clientX); s.x1 = Math.max(s.x1, e.clientX);
    s.y0 = Math.min(s.y0, e.clientY); s.y1 = Math.max(s.y1, e.clientY);
    s.types[e.type.replace('pointer', '')] = (s.types[e.type.replace('pointer', '')] || 0) + 1;
  }
  function stealText() {
    var keys = Object.keys(steals).sort(function (a, b) { return steals[b].n - steals[a].n; });
    if (!keys.length) return '  （沒有 —— 所有事件都落在畫布上）';
    return keys.slice(0, 6).map(function (k) {
      var s = steals[k];
      return '  ' + s.n + ' 次  ' + k +
        '\n      x=' + Math.round(s.x0) + '~' + Math.round(s.x1) +
        '  y=' + Math.round(s.y0) + '~' + Math.round(s.y1) +
        '  ' + Object.keys(s.types).map(function (t) { return t + '×' + s.types[t]; }).join(' ');
    }).join('\n');
  }

  function zoneText() {
    var cv = $('#blocks canvas.ink');
    var r = cv ? cv.getBoundingClientRect() : null;
    var mx = Math.max(1, Math.max.apply(null, zoneDoc));
    var rows = [];
    for (var i = 0; i < ZN; i++) {
      var x0 = Math.round(innerWidth * i / ZN), x1 = Math.round(innerWidth * (i + 1) / ZN);
      var inCv = r && x1 > r.left && x0 < r.right;
      rows.push('  ' + String(x0).padStart(4) + '-' + String(x1).padEnd(4) +
        (inCv ? ' 畫布' : '    ') +
        ' 網頁' + String(zoneDoc[i]).padStart(5) +
        ' 畫布' + String(zoneInk[i]).padStart(5) + '  ' +
        new Array(Math.round(zoneDoc[i] / mx * 24) + 1).join('#'));
    }
    return (r ? '畫布左右緣: x=' + Math.round(r.left) + ' ~ ' + Math.round(r.right) + '\n'
      : '（找不到畫布）\n') + rows.join('\n');
  }

  function diagText() {
    var cv = $('#blocks canvas.ink');
    var ta = cv ? getComputedStyle(cv).touchAction : '(沒有畫布)';
    var pe = cv ? getComputedStyle(cv).pointerEvents : '-';
    var L = evLog.map(function (x) {
      return '  ' + x.t + (x.n > 1 ? ' ×' + x.n : '') + '  ' + (x.pt || '?');
    }).join('\n') || '  （還沒有事件 —— 請先在畫布上寫一筆再打開）';
    return [
      /* 最重要的放最前面 —— 診斷視窗會被螢幕高度切掉，
         上一次就是重點在下面沒截到。 */
      '★ 事件時序（看每次筆的 UP 之前有沒有先出現「手掌」）：',
      seqText(),
      '',
      '螢幕: ' + innerWidth + '×' + innerHeight +
      '（' + (innerWidth > innerHeight ? '橫向' : '直向') + '）' +
      '  DPR=' + (devicePixelRatio || 1) + '  觸控點=' + (navigator.maxTouchPoints || 0),
      '模式: ' + Ink.mode +
      '　手掌防誤觸: ' + (Ink.fingerBlocked() ? '開' : '關') +
      '（penOnly=' + Ink.penOnly + '）',
      '畫布 touch-action: ' + ta + '　pointer-events: ' + pe,
      '#pagewrap touch-action: ' +
      getComputedStyle($('#pagewrap')).touchAction,
      'UA: ' + navigator.userAgent.slice(0, 60),
      '',
      '被畫布以外的元素接走的事件：',
      stealText(),
      '',
      '最近在畫布上的指標事件：',
      L,
      '',
      '指標事件的左右分布：',
      zoneText()
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
     輪盤：按住空白鍵 / 滑鼠右鍵（右鍵只在畫圖模式）
     ============================================================ */
  /* 輪盤換的是筆色，只有畫筆／螢光筆／橡皮擦模式用得到。
     選取模式（打字、選字）的右鍵要留給瀏覽器原本的選單 —— 複製、貼上、查詢。
     原本不分模式一律開輪盤、還把右鍵選單擋掉，選好字按右鍵只看到一圈
     跟文字無關的筆色，想複製反而沒辦法。 */
  function rightClickRadial() { return Ink.mode !== 'select'; }
  $('#pagewrap').addEventListener('contextmenu', function (e) {
    if (rightClickRadial()) e.preventDefault();
  });
  $('#pagewrap').addEventListener('pointerdown', function (e) {
    if (e.button === 2 && rightClickRadial()) { e.preventDefault(); Ink.radialOpen(e.clientX, e.clientY); }
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
          var root = Editor.currentRoot();
          if (root) Editor.History.checkpoint(root);    // 標記自己算一步，Ctrl+Z 才復原得了
          if (n === 0) Editor.clearMarks();
          else Editor.mark(e.shiftKey ? 'fc' : 'hl', n);
          root = Editor.currentRoot() || root;
          if (root) root.dispatchEvent(new Event('input'));
        } else if (n > 0) Ink.setColor(n - 1);
        return;
      }
      /* Alt+= / Alt+-：選取的字變大／變小 */
      if (code === 'Equal' || code === 'Minus' || code === 'NumpadAdd' || code === 'NumpadSubtract') {
        e.preventDefault();
        if (editing) changeSize(code === 'Equal' || code === 'NumpadAdd' ? 1 : -1);
        return;
      }
      /* 用 e.code 不用 e.key：Mac／iPad 鍵盤按 Option+R 得到的 key 是「®」 */
      if (code === 'KeyR') {
        e.preventDefault();
        if (e.shiftKey) loopSelection(); else speakSelection();
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
      if (kk === 'z' || kk === 'y') {
        var wantRedo = kk === 'y' || e.shiftKey;
        /* 正在文字段落裡：復原這一段的文字（打字、標記、貼上…）。
           絕對不能交給瀏覽器 —— 它不知道標記這件事，按下去會刪掉整段打好的字。
           標題、搜尋框這種一般輸入框就照瀏覽器原本的行為。 */
        var troot = editing && Ink.mode === 'select' ? Editor.currentRoot() : null;
        if (troot) {
          e.preventDefault();
          if (e.isComposing) return;              // 注音組字中不要動
          var did = wantRedo ? Editor.History.redo(troot) : Editor.History.undo(troot);
          if (!did) toast(wantRedo ? '沒有可以重做的了' : '這一段沒有可以復原的了');
          return;
        }
        if (!editing || Ink.mode !== 'select') {
          e.preventDefault();
          if (wantRedo) doRedo(); else doUndo();
          return;
        }
      }
    }

    /* 文字段落裡的 Tab：插入跳格字元，讓「單字　意思」這種清單對齊。
       用空白對不齊 —— 英文字母寬窄不一，call on 和 call for 打一樣多空白，
       後面的中文一定錯開。跳格會停在固定間隔的位置，前面長短差一點照樣對齊。
       瀏覽器預設的 Tab 是跳到下一個欄位，在筆記裡用不到。 */
    if (k === 'Tab' && editing && !e.ctrlKey && !e.altKey && !e.metaKey && Editor.currentRoot()) {
      e.preventDefault();
      if (e.isComposing) return;               // 注音組字中不要動
      if (e.shiftKey) removeTabBeforeCaret();
      else document.execCommand('insertText', false, '\t');
      return;
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

  /* Ctrl+滾輪調粗細 —— 只在畫筆、螢光筆、橡皮擦模式。
     打字模式要把 Ctrl+滾輪還給瀏覽器縮放畫面（原本一律攔下來，
     使用者就沒辦法用 Ctrl+滾輪放大縮小）。 */
  $('#pagewrap').addEventListener('wheel', function (e) {
    if (!e.ctrlKey || Ink.mode === 'select') return;
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
    Editor.History.checkpoint(root);       // 每一句語音自己算一步
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
    /* 允許呼叫端用 cond ? btn(...) : null 決定要不要放某顆按鈕 */
    (footNodes || []).forEach(function (n) { if (n) foot.appendChild(n); });
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

  /**
   * 觸控裝置上的按鈕要用 touchend 直接觸發。
   * 千萬不能在 touchstart 上 preventDefault —— 那會讓 iOS 不再合成 click，
   * 按鈕就完全按不動了（看得到、點不到）。
   * touchend 擋掉預設行為還有一個好處：焦點不會從輸入框跑掉，
   * 鍵盤不會收起來、選取也不會消失。
   * （原本只在 initTouchUI 裡用；複習卡片的朗讀鈕也需要，所以搬到外層。）
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
    /* 滑鼠按下時不要讓選取／焦點消失（桌機） */
    el.addEventListener('mousedown', function (e) { e.preventDefault(); });
  }

  /* Shift+Tab：刪掉游標前面的一個跳格（前面不是跳格就什麼都不做） */
  function removeTabBeforeCaret() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    var r = sel.getRangeAt(0), n = r.startContainer, o = r.startOffset;
    if (n.nodeType !== 3) {
      var prev = n.childNodes[o - 1];
      while (prev && prev.nodeType === 1 && prev.lastChild) prev = prev.lastChild;
      if (!prev || prev.nodeType !== 3) return;
      n = prev; o = prev.nodeValue.length;
    }
    if (o > 0 && n.nodeValue.charAt(o - 1) === '\t') document.execCommand('delete');
  }

  /* ---------- 字級 ---------- */
  function changeSize(delta) {
    var root = Editor.currentRoot();
    if (!root) { toast('先選取要改大小的字'); return null; }
    Editor.History.checkpoint(root);          // 改字級自己算一步，Ctrl+Z 可以復原
    var r = Editor.stepSize(delta);
    if (!r) { toast('先選取要改大小的字'); return null; }
    if (r.same) { toast(delta > 0 ? '已經是最大了' : '已經是最小了'); return r; }
    root.dispatchEvent(new Event('input'));
    return r;
  }

  /* ---------- 朗讀 ---------- */
  function sayText(t, opts) {
    if (!window.Speak || !Speak.supported) { toast('這個瀏覽器不支援朗讀'); return; }
    var r = Speak.say(t, opts);
    if (!r) { toast('沒有可以念的文字'); return; }
    if (r.slow) toast('🐢 放慢再念一次');
  }
  /* 選取在 iOS 上按按鈕時可能已經被收走，所以接受一個事先存下的範圍當備援 */
  function selectionText(range) {
    var sel = window.getSelection();
    return sel && !sel.isCollapsed ? String(sel) : (range ? range.toString() : '');
  }
  /* 選取的字中英文都念 ——「slash 斜線」整行選起來，聽完英文接著聽中文 */
  function speakSelection(range) {
    var t = selectionText(range);
    if (!t.trim()) { toast('先選取要念的字'); return; }
    sayText(t, { all: true });
  }
  function loopSelection(range) {
    var t = selectionText(range);
    if (!t.trim()) { toast('先選取要重複播放的字'); return; }
    startLoop(t);
  }

  /* 重複播放時浮在底部的控制列。
     放在選取色條（貼著底部 12px）上面，兩個同時出現才不會疊在一起。 */
  var speakbar = null;
  function speakbarEl() {
    if (speakbar) return speakbar;
    speakbar = document.createElement('div');
    speakbar.id = 'speakbar';
    speakbar.hidden = true;
    speakbar.innerHTML = '<span class="sp-n"></span><span class="sp-t"></span>' +
      '<button class="btn btn-sm sp-slow"></button>' +
      '<button class="btn btn-sm btn-primary sp-stop">⏹ 停止</button>';
    document.body.appendChild(speakbar);
    var slowBtn = $('.sp-slow', speakbar);
    onTap(slowBtn, function () {
      var on = !slowBtn.classList.contains('on');
      slowBtn.classList.toggle('on', on);
      slowBtn.textContent = on ? '🐇 正常速度' : '🐢 慢速';
      Speak.setLoopSlow(on);
      toast(on ? '下一遍開始放慢' : '下一遍恢復正常速度');
    });
    onTap($('.sp-stop', speakbar), function () { Speak.stopLoop('user'); });
    return speakbar;
  }
  function startLoop(t) {
    if (!window.Speak || !Speak.supported) { toast('這個瀏覽器不支援朗讀'); return; }
    var bar = speakbarEl();
    var slowBtn = $('.sp-slow', bar);
    slowBtn.classList.remove('on');
    slowBtn.textContent = '🐢 慢速';
    var r = Speak.loop(t, {
      all: true,
      onRound: function (n) { $('.sp-n', bar).textContent = '🔁 第 ' + n + ' 遍'; },
      onStop: function (why) {
        bar.hidden = true;
        if (why === 'blocked' || /^error/.test(why)) {
          toast('重複播放停下來了（沒有開始發聲，可能被系統擋下）。再按一次 🔁 試試');
        }
      }
    });
    if (!r) { toast('沒有可以念的文字'); return; }
    $('.sp-t', bar).textContent = r.text.length > 40 ? r.text.slice(0, 40) + '…' : r.text;
    bar.hidden = false;
  }
  /* Esc 停止重複播放。用捕獲階段，輸入框、彈窗自己的 Esc 處理照常進行 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && window.Speak && Speak.supported && Speak.looping()) Speak.stopLoop('user');
  }, true);
  function speakBtn(which, text, label) {
    if (!window.Speak || !Speak.supported || !Speak.segments(text).length) return '';
    return '<button type="button" class="speak-btn" data-say="' + which +
      '" title="朗讀（三秒內再按一次會放慢）">' + (label || '🔊') + '</button>';
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
      /* 看完答案按 R 念答案（作答中輸入框自己吃掉按鍵，不會誤觸） */
      if (e.code === 'KeyR' && stage.say) { e.preventDefault(); stage.say(); }
    }
    document.addEventListener('keydown', keyHandler);

    function finishUp() {
      document.removeEventListener('keydown', keyHandler);
      var ids = Object.keys(dirty);
      var chain = Promise.resolve();
      fullNotes.forEach(function (n) {
        if (!dirty[n.id]) return;
        chain = chain.then(function () {
          n.updatedAt = Date.now();     // 複習進度也算修改，另一台匯入時才帶得過去
          if (note && n.id === note.id) { note.cards = n.cards; note.updatedAt = n.updatedAt; return Store.put(note); }
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
        '<div class="card-q">' + Quiz.renderQ(c.q) + speakBtn('q', c.q) + '</div>' +
        '<div id="inputBox" style="margin:12px 0;"><input id="userAns" type="text" ' +
        'placeholder="在這裡作答，按 Enter 送出（不會的話直接按 Enter 看答案）" ' +
        'style="width:100%;padding:8px;font-size:14px;border:1px solid #ccc;border-radius:4px;"></div>' +
        '<div id="ansBox" hidden><div class="card-a" style="color:#2ecc71;margin:12px 0;"><strong>✓ 正確答案：</strong><br>' + Quiz.renderQ(c.a) + '</div>' +
        /* 朗讀鈕放在 .card-a 外面：申論題會把 .card-a 整個換成標示版本 */
        (speakBtn('a', c.a) ? '<div>' + speakBtn('a', c.a, '🔊 念答案') + '</div>' : '') +
        '<div id="feedback" style="color:#8A8680;font-size:13px;"></div></div>' +
        srcHTML + '</div>';

      openModal('🧠 複習（' + (i + 1) + ' / ' + queue.length + '）', contentHTML,
        [btn('送出（Enter）', 'btn-primary', function () { checkAnswer(); })]);

      Array.prototype.forEach.call($('#modalBody').querySelectorAll('.speak-btn'), function (b) {
        onTap(b, function () { sayText(b.getAttribute('data-say') === 'a' ? c.a : c.q); });
      });

      var inputEl = $('#userAns');
      if (inputEl) {
        inputEl.focus();
        inputEl.addEventListener('keydown', function (e) {
          /* 只有 Enter 才送出。空白鍵、數字鍵都要留給使用者打字
             （答案可能是「office worker」或含數字） */
          if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
          else if (e.altKey && e.code === 'KeyR') { e.preventDefault(); sayText(c.q); }
          else e.stopPropagation();
        });
      }

      stage.reveal = checkAnswer;
      stage.grade = grade;
      stage.say = function () { sayText(c.a); };

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
  /* ---------- 匯入：逐篇比對合併 ----------
     原本是整包覆蓋（同 ID 直接寫掉）。那會弄丟資料：週一從 iPad 匯出、
     週二在筆電改了同一篇、週三匯入週一的備份 —— 週二的修改就沒了，
     而且沒有任何提示。改成逐篇看 updatedAt 決定，永遠不用舊的蓋掉新的。

     判斷只靠兩台裝置的時鐘。時區設錯的話「誰比較新」會判斷錯 ——
     所以套用前一定先給使用者看清單，而且留一個還原點。 */
  /* 「未分類」可以改名，但它不是真的資料夾，名稱只存在這台裝置的 localStorage，
     以前也沒寫進備份檔 —— 在筆電把「未分類」改成「Davinci」，匯到 iPhone 還是「未分類」。
     現在名稱和修改時間都跟著備份檔走，匯入時跟資料夾一樣比新舊。 */
  function uncatInfo() {
    var name = localStorage.getItem('sn_uncategorizedName');
    if (!name) return null;
    return { name: name, at: +(localStorage.getItem('sn_uncategorizedNameAt') || 0) };
  }
  function uncatName() { var u = uncatInfo(); return u ? u.name : '未分類'; }
  function setUncat(u) {
    if (u && u.name) {
      localStorage.setItem('sn_uncategorizedName', u.name);
      if (u.at) localStorage.setItem('sn_uncategorizedNameAt', String(u.at));
      else localStorage.removeItem('sn_uncategorizedNameAt');
    } else {
      localStorage.removeItem('sn_uncategorizedName');
      localStorage.removeItem('sn_uncategorizedNameAt');
    }
  }

  function mergePlan(data, localNotes, localFolders) {
    var inNotes = data.notes || data;
    var inFolders = data.folders || [];
    var byId = {};
    localNotes.forEach(function (n) { byId[n.id] = n; });
    /* 舊格式的備份檔整包就是一個陣列，沒有 at 欄位。
       但陣列有 Array.prototype.at 這個「方法」，`data.at || 0` 會拿到函式
       而不是 0，時間就變成 Invalid Date。一定要確認型別。 */
    var p = {
      add: [], update: [], keep: [], same: [], folders: [],
      folderUpdate: [], folderKeep: [], folderConflict: [], localOnly: [], uncat: null,
      at: typeof data.at === 'number' ? data.at : 0
    };
    inNotes.forEach(function (f) {
      var l = byId[f.id];
      if (!l) { p.add.push({ f: f }); return; }
      var lu = l.updatedAt || 0, fu = f.updatedAt || 0;
      if (fu === lu) p.same.push({ f: f, l: l });
      else if (fu > lu) p.update.push({ f: f, l: l });
      else p.keep.push({ f: f, l: l });   // 本機比較新 —— 不覆蓋
    });
    /* 資料夾：本機沒有就新增；名稱、顏色都一樣就略過（排序差一點不算）。
       不一樣的話比 updatedAt：兩邊都有就比誰新；只有一邊有，有記錄的那邊
       一定是改版之後動過的，它比較新。
       兩邊都沒有（改版前就改過名）分不出來 —— 不能默默選一邊，
       列出來讓使用者自己勾。原本「已經有的一律不動」會讓改過的名稱永遠帶不過去。 */
    var lf = {};
    localFolders.forEach(function (x) { lf[x.id] = x; });
    inFolders.forEach(function (x) {
      var l = lf[x.id];
      if (!l) { p.folders.push(x); return; }
      if ((l.name || '') === (x.name || '') && (l.color || '') === (x.color || '')) return;
      var lu = l.updatedAt || 0, fu = x.updatedAt || 0;
      if (lu && fu) (fu > lu ? p.folderUpdate : p.folderKeep).push({ f: x, l: l });
      else if (fu) p.folderUpdate.push({ f: x, l: l });
      else if (lu) p.folderKeep.push({ f: x, l: l });
      else p.folderConflict.push({ f: x, l: l });
    });
    /* 本機有、備份檔沒有的筆記：分不出是新寫的還是在另一台刪掉了，所以不動，
       但要讓使用者在套用前就看到，不然匯入後才發現「怎麼多一篇」 */
    var inIds = {};
    inNotes.forEach(function (n) { inIds[n.id] = 1; });
    localNotes.forEach(function (n) { if (!inIds[n.id]) p.localOnly.push({ f: n }); });

    /* 「未分類」的名稱：規則跟資料夾一樣。本機從沒改過名就直接用檔案的 */
    var fu = data.uncat && data.uncat.name ? data.uncat : null;
    if (fu) {
      var lu = uncatInfo();
      var lname = lu ? lu.name : '未分類';
      if (fu.name !== lname) {
        var la = (lu && lu.at) || 0, fa = fu.at || 0;
        var kind = !lu ? 'update'
          : (la && fa) ? (fa > la ? 'update' : 'keep')
          : fa ? 'update' : la ? 'keep' : 'conflict';
        p.uncat = { kind: kind, f: { name: fu.name, at: fa }, l: lu };
      }
    }
    return p;
  }

  function tsText(t) {
    if (!t) return '沒有時間';
    return new Date(t).toLocaleString('zh-TW',
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function titleOf(n) { return esc(n.title || '未命名筆記'); }

  function showMergePlan(p) {
    var rows = [];
    function sec(list, label, color, detail) {
      if (!list.length) return;
      rows.push('<div style="margin:10px 0 4px;font-weight:700;color:' + color + '">' +
        label + ' ' + list.length + ' 篇</div>' +
        '<div style="font-size:12.5px;line-height:1.8;color:#5A564F">' +
        list.slice(0, 12).map(function (x) {
          return '　' + titleOf(x.f) + (detail ? '<span style="color:#8A8680">　' + detail(x) + '</span>' : '');
        }).join('<br>') +
        (list.length > 12 ? '<br>　<span style="color:#8A8680">…還有 ' + (list.length - 12) + ' 篇</span>' : '') +
        '</div>');
    }
    sec(p.add, '新增', '#3D7BD6');
    sec(p.update, '更新', '#4CAF8E', function (x) {
      return '檔案 ' + tsText(x.f.updatedAt) + ' 比本機 ' + tsText(x.l.updatedAt) + ' 新';
    });
    sec(p.keep, '保留本機（本機比較新，不覆蓋）', '#E8A33D', function (x) {
      return '本機 ' + tsText(x.l.updatedAt) + ' 比檔案 ' + tsText(x.f.updatedAt) + ' 新';
    });
    if (p.same.length) {
      rows.push('<div style="margin:10px 0 4px;color:#8A8680;font-size:12.5px">' +
        '內容相同、略過 ' + p.same.length + ' 篇</div>');
    }
    function fname(x) { return '「' + esc(x.name || '未命名資料夾') + '」'; }
    function fsec(list, label, color, line) {
      if (!list.length) return;
      rows.push('<div style="margin:10px 0 4px;font-weight:700;color:' + color + '">' +
        label + ' ' + list.length + ' 個</div>' +
        '<div style="font-size:12.5px;line-height:1.9;color:#5A564F">' +
        list.map(function (x) { return '　' + line(x); }).join('<br>') + '</div>');
    }
    function change(x) {
      var s = (x.l.name || '') !== (x.f.name || '')
        ? fname(x.l) + ' → ' + fname(x.f) : fname(x.f);
      if ((x.l.color || '') !== (x.f.color || '')) s += '<span style="color:#8A8680">（換了顏色）</span>';
      return s;
    }
    fsec(p.folders.map(function (f) { return { f: f }; }), '新增資料夾', '#3D7BD6', function (x) { return fname(x.f); });
    fsec(p.folderUpdate, '資料夾更新', '#4CAF8E', change);
    fsec(p.folderKeep, '資料夾保留本機（本機比較新）', '#E8A33D', function (x) {
      return fname(x.l) + '<span style="color:#8A8680">　備份檔裡叫' + fname(x.f) + '</span>';
    });
    fsec(p.folderConflict, '資料夾不一樣，分不出哪邊比較新，請選', '#C25B4E', function (x) {
      return '<label style="cursor:pointer"><input type="checkbox" class="fconf" data-id="' + esc(x.f.id) +
        '" checked style="vertical-align:middle;margin:0 6px 0 0">改用備份檔的' + change(x) +
        '<span style="color:#8A8680">（不勾 = 維持本機的）</span></label>';
    });
    if (p.uncat) {
      var U = p.uncat, from = fname({ name: U.l ? U.l.name : '未分類' }), to = fname({ name: U.f.name });
      if (U.kind === 'update') {
        rows.push('<div style="margin:10px 0 4px;font-weight:700;color:#4CAF8E">「未分類」的名稱</div>' +
          '<div style="font-size:12.5px;color:#5A564F">　' + from + ' → ' + to + '</div>');
      } else if (U.kind === 'keep') {
        rows.push('<div style="margin:10px 0 4px;font-weight:700;color:#E8A33D">「未分類」的名稱保留本機的（本機比較新）</div>' +
          '<div style="font-size:12.5px;color:#5A564F">　' + from +
          '<span style="color:#8A8680">　備份檔裡叫' + to + '</span></div>');
      } else {
        rows.push('<div style="margin:10px 0 4px;font-weight:700;color:#C25B4E">「未分類」的名稱不一樣，分不出哪邊比較新，請選</div>' +
          '<div style="font-size:12.5px;color:#5A564F">　<label style="cursor:pointer">' +
          '<input type="checkbox" class="uconf" checked style="vertical-align:middle;margin:0 6px 0 0">' +
          '改用備份檔的' + from + ' → ' + to + '<span style="color:#8A8680">（不勾 = 維持本機的）</span></label></div>');
      }
    }
    sec(p.localOnly, '只有本機有（備份檔裡沒有，保留不動）', '#8A8680', function () {
      return '';
    });
    if (p.localOnly.length) {
      rows.push('<div style="font-size:12px;color:#8A8680;margin:2px 0 0">　' +
        '如果是在另一台刪掉的，匯入後請在這台手動刪除。</div>');
    }
    var willChange = p.add.length + p.update.length + p.folders.length +
      p.folderUpdate.length + p.folderConflict.length +
      (p.uncat && p.uncat.kind !== 'keep' ? 1 : 0);

    openModal('要套用這些變更嗎？',
      '<p style="font-size:12.5px;color:#8A8680;margin:0 0 6px">' +
      '備份檔匯出時間：' + (p.at ? tsText(p.at) : '（舊格式，檔案沒記錄）') + '<br>' +
      '本機比較新的筆記不會被覆蓋。套用後可以一鍵還原。</p>' +
      rows.join('') +
      (willChange ? '' : '<p style="color:#8A8680">沒有需要套用的變更。</p>'),
      [
        willChange ? btn('套用（' + willChange + ' 項）', 'btn-primary', function () { applyMerge(p); }) : null,
        btn('取消', '', closeModal)
      ]);
  }

  /* 還原點：只記「我們動過什麼」，不是整個資料庫的快照 ——
     這樣還原時不會連使用者在匯入之後做的其他事一起打掉。
     只留在記憶體裡，重新載入就沒了，所以還原要趁當下。 */
  var lastMerge = null;
  function applyMerge(p) {
    /* 視窗還開著的時候先讀勾選狀態 */
    var chosen = p.folderConflict.filter(function (x) {
      var cb = $('#modalBody input.fconf[data-id="' + x.f.id + '"]');
      return cb && cb.checked;
    });
    var fUpd = p.folderUpdate.concat(chosen);
    var ucb = $('#modalBody input.uconf');
    var uncatTake = p.uncat && (p.uncat.kind === 'update' || (p.uncat.kind === 'conflict' && ucb && ucb.checked));
    var undo = {
      added: p.add.map(function (x) { return x.f.id; }),
      updated: p.update.map(function (x) { return x.l; }),   // 覆蓋前的本機版本
      folders: p.folders.map(function (x) { return x.id; }),
      folderPrev: fUpd.map(function (x) { return x.l; }),   // 資料夾被改名／換色前的本機版本
      uncatChanged: !!uncatTake,
      uncatPrev: uncatInfo(),
      at: Date.now()
    };
    var put = p.add.concat(p.update).map(function (x) { return x.f; });
    var fput = p.folders.concat(fUpd.map(function (x) { return x.f; }));
    if (uncatTake) setUncat(p.uncat.f);     // 在 reloadAll 重畫側欄之前寫好
    Store.putMany(put)
      .then(function () { return fput.length ? Store.putFolders(fput) : null; })
      .then(reloadAll)
      .then(function () {
        lastMerge = undo;
        refreshBackupBadge();
        closeModal();
        toast('已套用：新增 ' + p.add.length + ' 篇、更新 ' + p.update.length +
          ' 篇' + (p.keep.length ? '、保留本機 ' + p.keep.length + ' 篇' : '') +
          (fput.length ? '、資料夾 ' + fput.length + ' 個' : '') +
          '（可在備份/還原裡復原）');
      });
  }
  function undoMerge() {
    if (!lastMerge) return;
    var u = lastMerge;
    Promise.all(u.added.map(function (id) { return Store.del(id); }))
      .then(function () { return u.updated.length ? Store.putMany(u.updated) : null; })
      .then(function () {
        return Promise.all(u.folders.map(function (id) { return Store.delFolder(id); }));
      })
      .then(function () { return u.folderPrev && u.folderPrev.length ? Store.putFolders(u.folderPrev) : null; })
      .then(function () { if (u.uncatChanged) setUncat(u.uncatPrev); })
      .then(reloadAll)
      .then(function () {
        lastMerge = null;
        closeModal();
        toast('已還原到匯入前');
      });
  }
  function reloadAll() {
    return Promise.all([Store.all(), Store.folders()]).then(function (r) {
      notes = r[0]; folders = r[1];
      /* 目前開著的那篇可能剛被檔案的版本換掉，要重新讀出來畫 */
      if (note) {
        var fresh = notes.filter(function (n) { return n.id === note.id; })[0];
        if (fresh && fresh !== note) { note = fresh; openNote(note.id); }
        else if (!fresh) { note = null; $('#blocks').innerHTML = ''; }
      }
      renderList();
    });
  }

  /* 備份檔做好放著等使用者按。
     iOS 要求 navigator.share() 必須在使用者手勢的同一個任務裡呼叫 ——
     等 IndexedDB 讀完再呼叫就過了那個時機，分享選單會直接被擋掉。
     所以打開視窗時就先做好，按下去才是同步呼叫。 */
  var pending = null;
  function buildBackup() {
    if (saveTimer) { clearTimeout(saveTimer); save(); }
    pending = Promise.all([Store.all(), Store.folders()]).then(function (r) {
      var d = new Date();
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = '讀書筆記備份_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
        '_' + pad(d.getHours()) + pad(d.getMinutes()) +
        '_' + r[0].length + '篇.json';
      var blob = new Blob(
        [JSON.stringify({ v: 2, at: Date.now(), notes: r[0], folders: r[1], uncat: uncatInfo() })],
        { type: 'application/json' });
      var o = { blob: blob, name: name, n: r[0].length };
      try { o.file = new File([blob], name, { type: 'application/json' }); } catch (e) { }
      pending.ready = o;
      return o;
    });
    return pending;
  }
  function markBackedUp(n) {
    localStorage.setItem('sn_lastbackup', JSON.stringify({ at: Date.now(), n: n }));
    refreshBackupBadge();
  }
  function lastBackup() {
    try { return JSON.parse(localStorage.getItem('sn_lastbackup')); } catch (e) { return null; }
  }
  /* 超過七天沒備份就在按鈕上點一個紅點。會忘記才是常態。 */
  function refreshBackupBadge() {
    var b = $('#btnBackup'); if (!b) return;
    var lb = lastBackup();
    var stale = !lb || (Date.now() - lb.at) > 7 * 864e5;
    b.classList.toggle('needs-backup', stale);
    b.title = lb ? '上次備份：' + new Date(lb.at).toLocaleString('zh-TW') : '還沒有備份過';
  }
  refreshBackupBadge();

  function downloadBackup(o) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(o.blob);
    a.download = o.name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    markBackedUp(o.n);
  }

  /* ---------- 備份到雲端資料夾（電腦版 Chrome／Edge） ----------
     電腦上的分享選單只允許圖片、PDF、純文字這類檔案，.json 會被擋，
     原本就這樣默默退回成「下載」，按鈕卻寫「雲端」。
     改用瀏覽器的資料夾存取：選一次 OneDrive／Google 雲端硬碟裡的資料夾，
     之後直接把備份檔寫進去，同步程式會自動傳到雲端。
     資料夾的存取權杖可以存進 IndexedDB，但不跟筆記放同一個資料庫 ——
     那要升級資料庫版本，出錯會卡住筆記的讀取。另開一個小資料庫專門放它。 */
  var HandleDB = {
    _p: null,
    open: function () {
      if (!this._p) this._p = new Promise(function (res, rej) {
        var r = indexedDB.open('studynote-handles', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return this._p;
    },
    req: function (mode, fn) {
      return this.open().then(function (db) {
        return new Promise(function (res, rej) {
          var q = fn(db.transaction('kv', mode).objectStore('kv'));
          q.onsuccess = function () { res(q.result == null ? null : q.result); };
          q.onerror = function () { rej(q.error); };
        });
      });
    },
    get: function (k) { return this.req('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return this.req('readwrite', function (s) { return s.put(v, k); }); },
    del: function (k) { return this.req('readwrite', function (s) { return s.delete(k); }); }
  };
  var canFolder = typeof window.showDirectoryPicker === 'function';

  function pickBackupDir() {
    return window.showDirectoryPicker({ id: 'studynote-backup', mode: 'readwrite' })
      .then(function (dir) { return HandleDB.set('backupDir', dir).then(function () { return dir; }); });
  }
  /* 瀏覽器重開之後權限會回到「要再問一次」，要在按鈕的點擊裡重新要 */
  function backupDir(forcePick) {
    if (forcePick) return pickBackupDir();
    return HandleDB.get('backupDir').then(function (dir) {
      if (!dir) return pickBackupDir();
      return dir.queryPermission({ mode: 'readwrite' }).then(function (st) {
        if (st === 'granted') return dir;
        return dir.requestPermission({ mode: 'readwrite' }).then(function (st2) {
          if (st2 === 'granted') return dir;
          var err = new Error('沒有取得資料夾的寫入權限');
          err.name = 'NotAllowedError';
          throw err;
        });
      });
    });
  }
  function saveBackupToFolder(forcePick) {
    /* 兩件事同時開始：權限／選資料夾一定要在點擊當下發出，不能等備份檔做完 */
    return Promise.all([pending || buildBackup(), backupDir(forcePick)]).then(function (r) {
      var o = r[0], dir = r[1];
      return dir.getFileHandle(o.name, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w) { return w.write(o.blob).then(function () { return w.close(); }); })
        .then(function () {
          markBackedUp(o.n);
          closeModal();
          toast('已存到「' + dir.name + '」資料夾（' + o.n + ' 篇筆記）');
        });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;          // 選資料夾時按了取消
      if (err && err.name === 'NotFoundError') {
        HandleDB.del('backupDir');
        toast('原本的備份資料夾找不到了（可能被移動或刪除），請再按一次重新選');
        return;
      }
      if (err && err.name === 'NotAllowedError') {
        toast('沒有取得資料夾的寫入權限。再按一次，跳出詢問時選「允許」');
        return;
      }
      toast('存到資料夾失敗（' + ((err && err.message) || err) + '），先改成下載到本機');
      (pending || buildBackup()).then(downloadBackup);
    });
  }
  function fillBackupDirLine() {
    var line = $('#bkDirLine');
    if (!line || !canFolder) return;
    HandleDB.get('backupDir').then(function (dir) {
      if (!line.isConnected) return;
      if (!dir) {
        line.innerHTML = '還沒選過備份資料夾，<b>第一次按會請你選</b>。';
        return;
      }
      line.innerHTML = '目前存到「<b>' + esc(dir.name) + '</b>」資料夾　' +
        '<a href="#" id="bkChange" style="color:var(--accent)">換資料夾</a>';
      $('#bkChange').addEventListener('click', function (e) {
        e.preventDefault();
        saveBackupToFolder(true);
      });
    }).catch(function () { line.textContent = ''; });
  }

  $('#btnBackup').addEventListener('click', function () {
    buildBackup();
    var lb = lastBackup();
    var days = lb ? Math.floor((Date.now() - lb.at) / 864e5) : null;
    var when = !lb ? '<b style="color:#C25B4E">還沒有備份過。</b>'
      : (days >= 7 ? '<b style="color:#C25B4E">上次備份是 ' + days + ' 天前</b>（' : '上次備份：')
      + new Date(lb.at).toLocaleString('zh-TW') + (days >= 7 ? '）' : '');

    /* 三種情況，打開視窗時就判斷好，按鈕名稱要跟實際行為一致：
       1. 電腦 Chrome／Edge：直接寫進使用者選的雲端硬碟資料夾
       2. iPad／iPhone：系統分享選單 → 儲存到檔案 → iCloud／Google Drive／OneDrive
       3. 都不行：老實寫「下載」，說明檔案會在「下載」資料夾
       分享要先用同名同型別的檔案試 canShare —— 光看 navigator.share 存在不夠，
       電腦版 Chrome 有分享功能，但不允許分享 .json。 */
    var canShareFile = false;
    try {
      canShareFile = !!(navigator.canShare && navigator.share &&
        navigator.canShare({ files: [new File(['{}'], 'backup.json', { type: 'application/json' })] }));
    } catch (e) { canShareFile = false; }
    var acts = [];
    if (canFolder) {
      acts.push(btn('☁️ 備份到雲端資料夾', 'btn-primary', function () { saveBackupToFolder(false); }));
    } else if (canShareFile) {
      acts.push(btn('☁️ 備份到雲端', 'btn-primary', function () {
        var o = pending && pending.ready;
        var go = function (o) {
          if (!o || !o.file || !navigator.canShare({ files: [o.file] })) {
            downloadBackup(o);
            toast('這台裝置不能直接分享備份檔，已改成下載到本機');
            return;
          }
          navigator.share({ files: [o.file], title: o.name })
            .then(function () { markBackedUp(o.n); toast('已備份 ' + o.n + ' 篇筆記'); })
            .catch(function (err) {
              if (err && err.name === 'AbortError') return;   // 使用者自己取消
              downloadBackup(o);
              toast('分享沒有成功，已改成下載到本機');
            });
        };
        if (o) go(o); else pending.then(go);   // 還沒做完只好等，iOS 可能會擋
      }));
    }
    var cloud = canFolder || canShareFile;
    acts.push(btn(cloud ? '⬇ 只下載到本機' : '⬇ 下載備份檔', cloud ? '' : 'btn-primary', function () {
      var o = pending && pending.ready;
      if (o) downloadBackup(o); else pending.then(downloadBackup);
    }));

    var how = canFolder
      ? '<p style="font-size:12.5px;color:#8A8680">' +
        '按「備份到雲端資料夾」，第一次會請你選一個資料夾：選 <b>OneDrive</b> 或 ' +
        '<b>Google 雲端硬碟</b>裡的資料夾（例如新建一個「讀書筆記備份」），' +
        '同步程式會自動把檔案傳到雲端。之後按一下就直接存進去。' +
        '檔名有日期時間，不會蓋掉舊的。<br><span id="bkDirLine"></span></p>'
      : canShareFile
        ? '<p style="font-size:12.5px;color:#8A8680">' +
          '按「備份到雲端」會跳出分享選單，選<b>「儲存到檔案」</b>之後就能存到 ' +
          '<b>iCloud 雲碟／Google Drive／OneDrive</b>（要先裝好對應的 App）。' +
          '檔名有日期時間，不會蓋掉舊的。</p>'
        : '<p style="font-size:12.5px;color:#8A8680">' +
          '這個瀏覽器不能直接存到雲端。按「下載備份檔」會存到<b>「下載」資料夾</b>，' +
          '再自己搬到 OneDrive／Google 雲端硬碟。</p>';

    openModal('備份 / 還原',
      '<p style="font-size:13px;color:#8A8680">' + when + '<br>' +
      '筆記只存在這台裝置的瀏覽器裡，沒有自動同步 —— ' +
      '換裝置或清除瀏覽器資料前一定要先備份。</p>' + how,
      acts.concat([
      btn('⬆ 匯入備份檔', '', function () {
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json,application/json';
        inp.onchange = function () {
          var f = inp.files[0];
          if (!f) return;
          var fr = new FileReader();
          fr.onload = function () {
            var data;
            try {
              data = JSON.parse(fr.result);
              if (!Array.isArray(data.notes || data)) throw 0;
            } catch (e) { alert('檔案格式不正確。'); return; }
            Promise.all([Store.all(), Store.folders()]).then(function (r) {
              showMergePlan(mergePlan(data, r[0], r[1]));
            });
          };
          fr.readAsText(f);
        };
        inp.click();
      }),
      (lastMerge ? btn('↩ 還原到匯入前', '', function () { undoMerge(); }) : null),
      btn('🐞 診斷資訊', '', function () {
        var txt = diagText();
        /* 螢幕放不下整份報告，截圖一定會被切掉 —— 用複製的才拿得到全部。 */
        var copyBtn = btn('📋 複製全部', 'btn-primary', function () {
          var done = function () { copyBtn.textContent = '✓ 已複製，貼到對話裡就行'; };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(done, fallback);
          } else fallback();
          function fallback() {
            var ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
            document.body.appendChild(ta);
            ta.select(); ta.setSelectionRange(0, txt.length);
            try { document.execCommand('copy'); done(); }
            catch (e) { copyBtn.textContent = '複製失敗，請長按下面的文字選取'; }
            ta.remove();
          }
        });
        openModal('🐞 診斷資訊',
          '<p style="font-size:12.5px;color:#8A8680">先用筆在<b>會出問題的那一區</b>來回拖個幾次，' +
          '再回來打開這裡按「📋 複製全部」，直接貼到對話裡 —— ' +
          '截圖會被螢幕高度切掉，複製才拿得到完整內容。</p>' +
          '<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;' +
          'line-height:1.7;background:#F7F4EF;border-radius:10px;padding:12px;margin:0">' +
          esc(txt) + '</pre>',
          [copyBtn, btn('關閉', '', closeModal)]);
      })
    ]));
    fillBackupDirLine();
  });

  /* ============================================================
     啟動
     ============================================================ */
  window.addEventListener('beforeunload', function () {
    if (saveTimer) { clearTimeout(saveTimer); save(); }
  });

  initTouchUI();
  keepStorage();
  /* 標了顏色之後接著打字，不要把新字也塗上同一個顏色（全域裝一次就好） */
  Editor.keepMarksClosed();

  /* ============================================================
     朗讀轉 MP3
     手機螢幕一關，網頁的朗讀就被系統暫停，要有音檔才能一直聽。
     由筆電的 Windows 內建語音念成 MP3（serve.py → tts.ps1 → ffmpeg），
     存進備份用的 OneDrive 資料夾底下的「朗讀MP3」，手機的 OneDrive 直接播。
     ============================================================ */
  var ttsState = null;   // true 可以用；false 伺服器找不到 ffmpeg；undefined 伺服器是舊版

  var MP3_MODES = {
    recall: { label: '背誦：英文 → 停一下 → 中文 → 英文', tag: '背誦' },
    reverse: { label: '反向：中文 → 停一下 → 英文', tag: '反向' },
    read: { label: '朗讀：照順序念一遍', tag: '朗讀' }
  };

  /* 有選取文字就只轉選取的部分，沒有就整篇（所有文字區，表格一列算一行） */
  function mp3Source() {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount &&
      $('#blocks').contains(sel.getRangeAt(0).commonAncestorContainer)) {
      var t = sel.toString();
      if (t.trim()) return { text: t, part: true };
    }
    return {
      text: $$('#blocks .tblock .content').map(function (c) { return c.innerText; }).join('\n'),
      part: false
    };
  }

  /* 一行一組。同一行有英文也有中文才照背誦／反向的順序念，
     只有一種語言的行（標題、說明）就直接念過去。
     Windows 語音每句話結尾本來就會停大約一秒，下面的停頓是再額外加的：
     背誦時英文念完實際會停 2.5 秒左右，夠在腦中想一下中文。 */
  function mp3Items(text, mode) {
    var items = [];
    var P = function (ms) { items.push({ k: 'pause', ms: ms }); };
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var segs = Speak.segments(line);
      if (!segs.length) return;
      var en = segs.filter(function (s) { return s.kind === 'en'; }).map(function (s) { return s.text; }).join(' ');
      var zh = segs.filter(function (s) { return s.kind === 'zh'; }).map(function (s) { return s.text; }).join('，');
      if (mode === 'read' || !en || !zh) {
        segs.forEach(function (s) { items.push({ k: s.kind, t: s.text }); });
        P(500);
        return;
      }
      if (mode === 'recall') {
        items.push({ k: 'en', t: en }); P(1500);
        items.push({ k: 'zh', t: zh }); P(200);
        items.push({ k: 'en', t: en }); P(900);
      } else {
        items.push({ k: 'zh', t: zh }); P(1500);
        items.push({ k: 'en', t: en }); P(900);
      }
    });
    return items;
  }

  function mp3Name(mode) {
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var title = String(note.title || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40) || '未命名筆記';
    return title + '_' + MP3_MODES[mode].tag + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.mp3';
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  var mp3Busy = false;
  function makeMp3(mode) {
    if (mp3Busy) { toast('上一個 MP3 還在產生中'); return; }
    if (ttsState === undefined) {
      alert('「轉 MP3」是新加的功能，要重開伺服器才會生效：\n\n' +
        '1. 關掉那個黑色的「StudyNote」視窗\n2. 再點一次「啟動筆記工具」');
      return;
    }
    if (ttsState === false) { toast('這台電腦找不到 ffmpeg，沒辦法轉成 MP3'); return; }
    var src = mp3Source();
    var items = mp3Items(src.text, mode);
    var n = items.filter(function (i) { return i.k !== 'pause'; }).length;
    if (!n) { toast(src.part ? '選取的部分沒有可以念的文字' : '這份筆記沒有可以念的文字'); return; }

    /* 資料夾的權限要在點擊當下要，等 MP3 做好才要會被瀏覽器擋掉 */
    var dirP = !canFolder ? Promise.resolve(null) : backupDir(false).then(function (dir) {
      return dir.getDirectoryHandle('朗讀MP3', { create: true }).then(function (sub) {
        return { dir: dir, sub: sub };
      });
    }).catch(function (err) { return { err: err }; });

    var btn = $('#btnMp3'), old = btn.textContent;
    mp3Busy = true;
    btn.disabled = true;
    btn.textContent = '⏳ 產生中…';
    toast('正在產生 MP3（' + (src.part ? '選取的部分' : '整篇') + '，' + n + ' 段），長的筆記要等一下');
    var done = function () { mp3Busy = false; btn.disabled = false; btn.textContent = old; };

    fetch('tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, rate: -1 })
    }).then(function (r) {
      if (r.ok) return r.blob();
      return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error(j.error || ('HTTP ' + r.status));
      });
    }).then(function (blob) {
      var name = mp3Name(mode);
      var sec = Math.round(blob.size * 8 / 64000);          // 64kbps
      var len = sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒';
      return dirP.then(function (d) {
        if (!d || d.err) {
          downloadBlob(blob, name);
          if (d && d.err && d.err.name !== 'AbortError') toast('沒辦法存進備份資料夾，已改成下載：' + name + '（' + len + '）');
          else toast('已下載 ' + name + '（' + len + '）');
          return;
        }
        return d.sub.getFileHandle(name, { create: true })
          .then(function (fh) { return fh.createWritable(); })
          .then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
          .then(function () {
            toast('已存到「' + d.dir.name + '／朗讀MP3」：' + name + '（' + len + '）');
          });
      });
    }).catch(function (e) {
      toast('轉 MP3 失敗：' + ((e && e.message) || e));
    }).then(done, done);
  }

  $('#btnMp3').addEventListener('click', function (e) {
    var src = mp3Source();
    var items = [{ head: src.part ? '把「選取的部分」念成 MP3' : '把「整篇筆記」念成 MP3（先選取文字就只轉那一段）' }];
    Object.keys(MP3_MODES).forEach(function (m) {
      items.push({ label: MP3_MODES[m].label, fn: function () { makeMp3(m); } });
    });
    popup(e.currentTarget, items);
  });

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
      .then(function (j) {
        document.body.classList.toggle('no-ocr', !(j && j.ocr));
        ttsState = j ? j.tts : null;          // 舊版伺服器沒有這個欄位 -> undefined
      })
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

/* 有新版本時提醒重新整理。
   頁面開著好幾天的話，跑的一直是當初載入的舊程式 —— 使用者就遇到：
   圖片轉表格已經修好，他那個分頁還是舊版，結果跟修之前一模一樣，
   而畫面上完全看不出來。回到這個分頁時去看一下 index.html 裡的版本號，
   不一樣就跳出提示。不自動重新整理：可能正在打字。 */
(function () {
  var s = document.querySelector('script[src*="app.js?v="]');
  var mv = s && /v=(\d+)/.exec(s.getAttribute('src'));
  var mine = mv ? mv[1] : '';
  if (!mine || !window.fetch) return;
  var shown = false, last = 0;
  function check() {
    if (shown || Date.now() - last < 60000) return;
    last = Date.now();
    fetch('index.html?check=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.text() : '';
    }).then(function (html) {
      var m = /app\.js\?v=(\d+)/.exec(html || '');
      if (!m || m[1] === mine) return;
      shown = true;
      var bar = document.createElement('div');
      bar.id = 'updbar';
      bar.innerHTML = '有新版本，重新整理後才會生效 <button type="button">重新整理</button>';
      bar.querySelector('button').onclick = function () { location.reload(); };
      document.body.appendChild(bar);
    }).catch(function () {});
  }
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  setInterval(check, 10 * 60 * 1000);
})();
