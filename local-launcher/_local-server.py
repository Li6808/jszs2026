#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
教师助手 · 在电脑上打开 —— 极简本机静态服务器（Python 版）
零依赖，只用标准库。给没装 Node.js 的电脑兜底，由「双击打开」脚本自动调用。
"""
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
START_PORT = 8790


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        kwargs['directory'] = ROOT
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass  # 静音，别刷屏

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


def free_port(start):
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    return None


def main():
    port = free_port(START_PORT)
    if port is None:
        print('')
        print('  ❌ 找不到空闲端口，请关掉一些程序再试。')
        return 1

    url = 'http://127.0.0.1:%d/' % port
    print('')
    print('  📚 教师助手 · 已在你的电脑上打开')
    print('  ' + '─' * 41)
    print('  地址      ' + url)
    print('  数据位置  这个浏览器的本地存储里')
    print('  联网要求  不需要，断网照样用')
    print('')
    print('  ⚠️  这个窗口就是服务，别关它（最小化可以）。')
    print('      用完请按 Control + C 停止，数据不会丢。')
    print('')
    print('  💡 想换电脑带走数据：进「个人设置 → 数据备份」导出一份，')
    print('     在新电脑上导入即可。')
    print('')

    threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    with ReusableServer(('127.0.0.1', port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('')
            print('  已停止。数据还在浏览器里，不会丢。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
