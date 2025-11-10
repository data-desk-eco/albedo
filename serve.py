#!/usr/bin/env python3
"""Simple HTTP server with Range request support for PMTiles"""
import http.server
import socketserver
import os

class RangeRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_GET(self):
        # Get file path
        path = self.translate_path(self.path)

        if not os.path.exists(path) or not os.path.isfile(path):
            return super().do_GET()

        file_size = os.path.getsize(path)

        # Check for Range header
        range_header = self.headers.get('Range')
        if not range_header:
            return super().do_GET()

        # Parse range header
        try:
            byte_range = range_header.strip().split('=')[1]
            start, end = byte_range.split('-')
            start = int(start) if start else 0
            end = int(end) if end else file_size - 1

            if start >= file_size:
                self.send_error(416, 'Requested Range Not Satisfiable')
                return

            end = min(end, file_size - 1)
            length = end - start + 1

            # Send response
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.send_header('Content-Length', str(length))
            self.end_headers()

            # Send file chunk
            with open(path, 'rb') as f:
                f.seek(start)
                self.wfile.write(f.read(length))
        except Exception as e:
            print(f"Error handling range request: {e}")
            return super().do_GET()

PORT = 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))

with socketserver.TCPServer(("", PORT), RangeRequestHandler) as httpd:
    print(f"Serving at http://localhost:{PORT}")
    print("Press Ctrl+C to stop")
    httpd.serve_forever()
