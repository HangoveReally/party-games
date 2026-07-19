#!/usr/bin/env python3
"""Локальный сервер для тестов пати-игр. Запуск: python serve.py  ->  http://localhost:8080"""
import http.server, socketserver, os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Открой http://localhost:{PORT}  (Ctrl+C — стоп)")
    httpd.serve_forever()
