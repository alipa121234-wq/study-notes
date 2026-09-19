# -*- coding: utf-8 -*-
"""
讀書筆記工具的本機伺服器。

設計重點：
1. 只綁 loopback（127.0.0.1 + ::1），不會跳出 Windows 防火牆警告。
   同時綁 IPv6 是因為 Windows 的 localhost 常常先解析成 ::1，
   只綁 IPv4 的話瀏覽器會出現 ERR_CONNECTION_REFUSED。
2. 多執行緒處理請求，避免單一請求卡住時後續連線被拒。
3. 送 no-store 快取標頭，改完程式重新整理就一定拿到新版。
4. 由 Python 自己在「socket 確定在監聽之後」才打開瀏覽器。
5. 網址固定用 http://localhost:8760/。瀏覽器的 IndexedDB 是按網址來源分開存的，
   localhost 和 127.0.0.1 算兩個不同來源，換掉就會看不到原本的筆記。

想在 iPad / iPhone 上用同一個 Wi-Fi 連進來測試時：
    py serve.py lan
會改綁所有網卡並印出網址（這時 Windows 可能會問一次防火牆，選「允許」）。
"""
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser

PORT = 8760

# 圖片轉文字：呼叫 Windows 內建的 OCR（透過同資料夾的 ocr.ps1）
OCR_SCRIPT = 'ocr.ps1'
OCR_LANGS = ('zh-Hant-TW', 'en-US', 'en-GB')
OCR_TIMEOUT = 60
MAX_UPLOAD = 24 * 1024 * 1024

# 朗讀轉 MP3：Windows 內建語音（tts.ps1）念成 WAV，再用 ffmpeg 轉成 MP3。
# 手機螢幕關掉之後網頁的朗讀會被暫停，要有音檔才能一直聽。
TTS_SCRIPT = 'tts.ps1'
TTS_TIMEOUT = 900                 # 很長的筆記念起來要好幾分鐘
TTS_MAX_ITEMS = 6000
TTS_MAX_CHARS = 120000


def find_ffmpeg():
    """PATH 上找不到就看 ~/bin（使用者手動放的那一份）。"""
    p = shutil.which('ffmpeg')
    if p:
        return p
    cand = os.path.join(os.path.expanduser('~'), 'bin', 'ffmpeg.exe')
    return cand if os.path.exists(cand) else None

# 這些型別要補上 charset=utf-8，否則直接開啟 .js/.css 會是亂碼
TEXT_TYPES = (
    'text/html', 'text/css', 'text/plain', 'text/javascript',
    'application/javascript', 'application/json',
)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def guess_type(self, path):
        t = super().guess_type(path)
        if isinstance(t, tuple):          # 不同 Python 版本回傳型別不一樣
            t = t[0]
        if t and 'charset=' not in t and t.split(';')[0].strip() in TEXT_TYPES:
            t += '; charset=utf-8'
        return t

    def log_message(self, fmt, *args):
        # 只記 4xx / 5xx，正常請求不用洗版
        status = args[1] if len(args) > 1 else ''
        if str(status).startswith(('4', '5')):
            super().log_message(fmt, *args)

    def do_GET(self):
        # 讓前端知道「這份頁面是由本機的 Python 在服務」，因而有 OCR 可用。
        # 部署到靜態主機之後這個端點不存在，前端就會把 🔤 按鈕藏起來。
        if urllib.parse.urlparse(self.path).path == '/health':
            self._json(200, {'ocr': True, 'tts': bool(find_ffmpeg())})
            return
        super().do_GET()

    # ---------- 圖片轉文字 ----------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/tts':
            try:
                mp3 = self._tts()
            except Exception as e:                  # noqa: BLE001 一律回給前端顯示
                self._json(500, {'error': str(e) or e.__class__.__name__})
                return
            self.send_response(200)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Content-Length', str(len(mp3)))
            self.end_headers()
            self.wfile.write(mp3)
            return
        if path != '/ocr':
            self.send_error(404, 'Not Found')
            return
        try:
            self._json(200, self._ocr())
        except Exception as e:                      # noqa: BLE001 一律回給前端顯示
            self._json(500, {'error': str(e) or e.__class__.__name__})

    def _tts(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > 4 * 1024 * 1024:
            raise ValueError('朗讀內容太長或是空的')
        job = json.loads(self.rfile.read(n).decode('utf-8'))

        # 只收我們認得的欄位，其餘丟掉；文字寫進檔案交給腳本，不會進到命令列
        items, chars = [], 0
        for it in (job.get('items') or [])[:TTS_MAX_ITEMS]:
            k = it.get('k')
            if k == 'pause':
                items.append({'k': 'pause', 'ms': max(0, min(20000, int(it.get('ms') or 0)))})
            elif k in ('en', 'zh'):
                t = str(it.get('t') or '')[:2000]
                chars += len(t)
                items.append({'k': k, 't': t})
        if not any(i['k'] != 'pause' for i in items):
            raise ValueError('沒有可以念的文字')
        if chars > TTS_MAX_CHARS:
            raise ValueError('內容太長（上限 %d 字），請分成幾段轉' % TTS_MAX_CHARS)
        rate = max(-5, min(5, int(job.get('rate') or 0)))

        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError('這台電腦找不到 ffmpeg，沒辦法轉成 MP3')
        here = os.path.dirname(os.path.abspath(__file__))
        script = os.path.join(here, TTS_SCRIPT)
        if not os.path.exists(script):
            raise RuntimeError('找不到 %s，請確認它跟 serve.py 在同一個資料夾' % TTS_SCRIPT)

        d = tempfile.mkdtemp(prefix='studynote-tts-')
        src = os.path.join(d, 'job.json')
        wav = os.path.join(d, 'out.wav')
        mp3 = os.path.join(d, 'out.mp3')
        try:
            with open(src, 'w', encoding='utf-8') as f:
                json.dump({'items': items, 'rate': rate}, f, ensure_ascii=False)
            p = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive',
                 '-ExecutionPolicy', 'Bypass', '-File', script,
                 '-In', src, '-Out', wav],
                capture_output=True, timeout=TTS_TIMEOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if p.returncode != 0 or not os.path.exists(wav):
                err = (p.stderr or b'').decode('utf-8', 'replace')
                msg = err.split('TTS_ERROR:', 1)[1].strip() if 'TTS_ERROR:' in err else ''
                raise RuntimeError('語音合成失敗' + ('：' + msg[:200] if msg else ''))
            # 單聲道 64kbps：人聲夠清楚，一小時大約 28 MB
            q = subprocess.run(
                [ffmpeg, '-v', 'error', '-y', '-i', wav, '-ac', '1', '-b:a', '64k', mp3],
                capture_output=True, timeout=TTS_TIMEOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if q.returncode != 0 or not os.path.exists(mp3):
                raise RuntimeError('轉成 MP3 失敗')
            with open(mp3, 'rb') as f:
                return f.read()
        except subprocess.TimeoutExpired:
            raise RuntimeError('朗讀內容太長，處理逾時，請分成幾段轉')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ocr(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0:
            raise ValueError('沒有收到圖片')
        if n > MAX_UPLOAD:
            raise ValueError('圖片太大（上限 %d MB）' % (MAX_UPLOAD // 1024 // 1024))
        data = self.rfile.read(n)

        # 語言只接受白名單，不讓外部字串進到命令列
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        lang = (q.get('lang') or ['zh-Hant-TW'])[0]
        if lang not in OCR_LANGS:
            lang = 'zh-Hant-TW'

        here = os.path.dirname(os.path.abspath(__file__))
        script = os.path.join(here, OCR_SCRIPT)
        if not os.path.exists(script):
            raise RuntimeError('找不到 %s，請確認它跟 serve.py 在同一個資料夾' % OCR_SCRIPT)

        # 檔名由我們自己產生，不會有外部輸入進到路徑
        d = tempfile.mkdtemp(prefix='studynote-ocr-')
        img = os.path.join(d, 'in.png')
        out = os.path.join(d, 'out.txt')
        try:
            with open(img, 'wb') as f:
                f.write(data)
            p = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive',
                 '-ExecutionPolicy', 'Bypass', '-File', script,
                 '-Path', img, '-Out', out, '-Lang', lang],
                capture_output=True, timeout=OCR_TIMEOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if p.returncode != 0 or not os.path.exists(out):
                raise RuntimeError(_ocr_error(p))
            with open(out, encoding='utf-8') as f:
                # ocr.ps1 只回傳每一行的文字與座標，版面由前端重組
                # （它同時要看圖片像素才找得到填空的底線）
                return {'lines': json.load(f).get('lines') or []}
        except subprocess.TimeoutExpired:
            raise RuntimeError('OCR 逾時，圖片可能太大')
        finally:
            shutil.rmtree(d, ignore_errors=True)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class Server6(Server):
    address_family = socket.AF_INET6


def _ocr_error(p):
    """把 ocr.ps1 的 stderr 轉成看得懂的中文訊息。"""
    err = (p.stderr or b'').decode('utf-8', 'replace')
    msg = ''
    for line in err.splitlines():
        if 'OCR_ERROR:' in line:
            msg = line.split('OCR_ERROR:', 1)[1].strip()
            break
    if 'language pack' in msg:
        return ('這台電腦沒有安裝這個語言的 OCR 語言包。\n'
                '到「設定 → 時間與語言 → 語言與地區」，'
                '點該語言的「⋯ → 語言選項」，安裝「光學字元辨識」。')
    if 'cannot read image' in msg:
        return '讀不到這張圖片（格式可能不支援）'
    if 'recognition failed' in msg:
        return 'OCR 引擎辨識失敗'
    if msg:
        return msg[:300]
    return 'OCR 執行失敗（結束碼 %d）' % p.returncode


def make(host, cls):
    """開一個監聽器；開不起來就回 None（例如系統沒有 IPv6）。"""
    try:
        return cls((host, PORT), NoCacheHandler)
    except OSError:
        return None


def lan_ip():
    """取得這台電腦在區網的 IP（不會真的送出封包）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def port_in_use(host, port, family=socket.AF_INET):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(0.4)
    try:
        return s.connect_ex((host, port)) == 0
    except OSError:
        return False
    finally:
        s.close()


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    lan = len(sys.argv) > 1 and sys.argv[1].lower() == 'lan'
    # 一定要用 localhost：瀏覽器的資料（IndexedDB）是按網址來源分開存的，
    # 換成 127.0.0.1 會變成另一個來源，看不到原本的筆記。
    url = 'http://localhost:%d/' % PORT

    # 已經有一份在跑 -> 直接開瀏覽器就好，不要重複啟動
    if (port_in_use('127.0.0.1', PORT)
            or port_in_use('::1', PORT, socket.AF_INET6)):
        print('  已經有一份在執行中，直接開啟瀏覽器。')
        webbrowser.open(url)
        return 0

    servers = []
    if lan:
        # IPv4 和 IPv6 都要綁。<電腦名稱>.local 這種 mDNS 位址在 iPhone/iPad
        # 上會優先解析成 IPv6，只綁 IPv4 的話那個固定位址會連不上，
        # 每次換網路就得重查 IP。
        for host, cls in (('', Server), ('::', Server6)):
            s = make(host, cls)
            if s:
                servers.append(s)
    else:
        for host, cls in (('127.0.0.1', Server), ('::1', Server6)):
            s = make(host, cls)
            if s:
                servers.append(s)

    if not servers:
        print('[ERROR] 無法在連接埠 %d 啟動（可能被其他程式佔用）。' % PORT)
        input('按 Enter 關閉…')
        return 1

    # 走到這裡 socket 已經 bind + listen，瀏覽器現在連進來一定接得到
    print('')
    print('  讀書筆記工具已啟動   %s' % url)
    if lan:
        print('')
        print('  ' + '=' * 52)
        print('   iPad / iPhone 請開這個網址：')
        print('')
        print('       http://%s.local:%d' % (socket.gethostname(), PORT))
        print('')
        print('   ↑ 這個位址「不會變」，換 Wi-Fi、用熱點都一樣，可以加書籤。')
        print('     連不上時再試備用位址： http://%s:%d' % (lan_ip(), PORT))
        print('     （備用位址每次換網路都會不同）')
        print('  ' + '=' * 52)
    print('  ' + '-' * 46)
    print('  這個視窗就是伺服器，使用期間請保持開啟。')
    print('  要結束請直接關掉這個視窗，或按 Ctrl+C。')
    print('')

    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    threading.Timer(0.2, lambda: webbrowser.open(url)).start()

    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
    finally:
        for s in servers:
            s.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
