# -*- coding: utf-8 -*-
"""
在 index.html 的 CSS / JS 網址後面蓋上一個版本戳記。

為什麼需要：GitHub Pages 會叫瀏覽器把 .js / .css 快取十分鐘。
推了新版之後，使用者按重新整理仍然會拿到舊檔案，於是「明明改好了卻沒生效」。
網址後面帶不同的 ?v= 就會被當成不同的檔案，一定會重抓。

用法（推上去之前跑一次）：
    py bump.py
"""
import io
import os
import re
import sys
import time

ASSETS = re.compile(
    r'((?:href|src)=")((?:app\.css|js/[A-Za-z0-9_.-]+\.js))(?:\?v=[0-9]+)?(")'
)


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    stamp = time.strftime('%Y%m%d%H%M%S')

    with io.open('index.html', encoding='utf-8') as f:
        html = f.read()

    new, n = ASSETS.subn(r'\g<1>\g<2>?v=' + stamp + r'\g<3>', html)
    if not n:
        print('[WARN] no CSS/JS tag found - has index.html been changed?')
        return 1

    if new != html:
        with io.open('index.html', 'w', encoding='utf-8', newline='') as f:
            f.write(new)
    # 訊息保持純 ASCII：從 Git Bash 跑的時候 stdout 是 cp1252，
    # 印中文會炸成 UnicodeEncodeError，讓整支腳本回傳 1。
    print('stamped %s (%d files)' % (stamp, n))
    return 0


if __name__ == '__main__':
    sys.exit(main())
