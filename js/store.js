/* ============================================================
   store.js — IndexedDB 儲存層
   資料模型
   Note {
     id, title, createdAt, updatedAt,
     blocks: [ Block ],
     cards:  [ Card ]
   }
   Block {
     id, type:'text'|'image'|'sketch',
     html?      文字區塊的 HTML
     src?       圖片 dataURL
     ratio?     圖片 高/寬
     h?         手寫區高度 px
     cap?       圖說（圖片／手寫區）
     strokes: [ Stroke ]
   }
   Stroke { tool:'pen'|'hl', color, size, pts:[[x,y,pressure],...] }
     文字區塊：x 為寬度比例(0~1)、y 為絕對 px
     圖片/手寫區：x、y 皆為比例(0~1)
   Card {
     id, type, q, a, blockId, box(0~4), due(ts), seen, right, src('auto'|'manual'|'ai')
   }
   ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'studynote-db';
  var DB_VER = 2;
  var STORE = 'notes';
  var FSTORE = 'folders';
  var dbp = null;

  var blockedNotified = false;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FSTORE)) db.createObjectStore(FSTORE, { keyPath: 'id' });
      };

      /* 其他分頁還開著舊版本 → 升級會無限期卡住，要講清楚 */
      req.onblocked = function () {
        if (blockedNotified) return;
        blockedNotified = true;
        alert('資料庫需要更新，但還有「其他分頁」開著這個工具的舊版本。\n\n' +
          '請把其他分頁全部關掉，只留這一個，然後重新整理（Ctrl+Shift+R）。');
      };

      req.onsuccess = function () {
        var db = req.result;
        /* 換我們擋到別人的升級時，主動讓開 */
        db.onversionchange = function () {
          db.close();
          dbp = null;
          alert('資料已在另一個分頁更新，請重新整理這個分頁。');
        };
        res(db);
      };

      req.onerror = function () { dbp = null; rej(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  var Store = {
    all: function () {
      return tx(STORE, 'readonly', function (s) { return s.getAll(); }).then(function (r) {
        var list = r || [];
        list.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        return list;
      });
    },
    get: function (id) { return tx(STORE, 'readonly', function (s) { return s.get(id); }); },
    put: function (note) { return tx(STORE, 'readwrite', function (s) { return s.put(note); }); },
    del: function (id) { return tx(STORE, 'readwrite', function (s) { return s.delete(id); }); },
    putMany: function (notes) {
      return tx(STORE, 'readwrite', function (s) { notes.forEach(function (n) { s.put(n); }); });
    },
    clear: function () { return tx(STORE, 'readwrite', function (s) { return s.clear(); }); },

    /* ---- 資料夾 ---- */
    folders: function () {
      return tx(FSTORE, 'readonly', function (s) { return s.getAll(); }).then(function (r) {
        var list = r || [];
        list.sort(function (a, b) { return (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt; });
        return list;
      });
    },
    putFolder: function (f) { return tx(FSTORE, 'readwrite', function (s) { return s.put(f); }); },
    delFolder: function (id) { return tx(FSTORE, 'readwrite', function (s) { return s.delete(id); }); },
    putFolders: function (list) {
      return tx(FSTORE, 'readwrite', function (s) { list.forEach(function (f) { s.put(f); }); });
    }
  };

  /* ---------- helpers ---------- */
  function uid(p) {
    return (p || 'x') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function newNote(title, folderId) {
    var now = Date.now();
    return {
      id: uid('n'),
      title: title || '',
      folderId: folderId || null,
      createdAt: now,
      updatedAt: now,
      blocks: [newBlock('text')],
      cards: []
    };
  }

  /* 資料夾顏色（依建立順序自動指派，可在選單裡換） */
  var FOLDER_COLORS = ['#FF8C69', '#4CAF8E', '#3D7BD6', '#E8A33D', '#B07FD6', '#E5686B', '#5BBCC4', '#8A8680'];

  function newFolder(name, order) {
    return {
      id: uid('f'),
      name: name || '新資料夾',
      color: FOLDER_COLORS[(order || 0) % FOLDER_COLORS.length],
      order: order || 0,
      createdAt: Date.now()
    };
  }

  function nextColor(c) {
    var i = FOLDER_COLORS.indexOf(c);
    return FOLDER_COLORS[(i + 1) % FOLDER_COLORS.length];
  }

  function newBlock(type, extra) {
    var b = { id: uid('b'), type: type, strokes: [] };
    if (type === 'text') b.html = '';
    if (type === 'image') { b.src = ''; b.ratio = 0.6; b.cap = ''; }
    if (type === 'sketch') { b.h = 380; b.cap = ''; }
    if (extra) for (var k in extra) b[k] = extra[k];
    return b;
  }

  /* Leitner 複習間隔（天） */
  var BOX_DAYS = [0, 1, 3, 7, 16];

  function newCard(o) {
    return {
      id: uid('c'),
      type: o.type || 'qa',
      q: o.q || '',
      a: o.a || '',
      blockId: o.blockId || '',
      hint: o.hint || '',
      box: 0,
      due: Date.now(),
      seen: 0,
      right: 0,
      src: o.src || 'auto'
    };
  }

  function schedule(card, grade) {
    // grade: 0 不熟 / 1 普通 / 2 熟
    card.seen++;
    if (grade === 2) { card.right++; card.box = Math.min(4, card.box + 1); }
    else if (grade === 1) { card.right++; card.box = Math.min(4, card.box + (card.box < 2 ? 1 : 0)); }
    else { card.box = 0; }
    var days = BOX_DAYS[card.box];
    card.due = Date.now() + days * 864e5 + (days === 0 ? 6e4 : 0);
    return card;
  }

  function dueCount(note) {
    var now = Date.now(), n = 0;
    (note.cards || []).forEach(function (c) { if (c.due <= now) n++; });
    return n;
  }

  global.Store = Store;
  global.M = {
    uid: uid, newNote: newNote, newBlock: newBlock, newCard: newCard,
    newFolder: newFolder, nextColor: nextColor, FOLDER_COLORS: FOLDER_COLORS,
    schedule: schedule, dueCount: dueCount, BOX_DAYS: BOX_DAYS
  };
})(window);
