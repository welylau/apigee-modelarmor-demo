#!/usr/bin/env python3
"""
Apigee Model Armor Demonstration Web Server
Serves the demonstration UI and proxies requests to:
- SMR-no-streaming (https://YOUR_APIGEE_HOST/smr-no-streaming)
- SMR-streaming-sse (https://YOUR_APIGEE_HOST/smr-streaming-sse)
"""

import http.server
import json
import mimetypes
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/png", ".png")
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", 8080))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

NO_STREAMING_URL = "https://YOUR_APIGEE_HOST/smr-no-streaming"
STREAMING_SSE_URL = "https://YOUR_APIGEE_HOST/smr-streaming-sse"

ssl_ctx = ssl.create_default_context()

class DemoHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Clean custom logging without printing sensitive data
        sys.stderr.write(f"[{self.log_date_time_string()}] {self.command} {self.path}\n")

    def _set_security_headers(self, content_type):
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src https://fonts.gstatic.com; "
            "img-src 'self' data:; connect-src 'self';"
        )

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        # Serve static assets
        clean_path = self.path.split("?")[0].lstrip("/")
        if clean_path.endswith("favicon.ico"):
            self.send_response(204)
            self.end_headers()
            return

        if not clean_path or clean_path == "":
            file_path = os.path.join(STATIC_DIR, "index.html")
        else:
            # Prevent path traversal
            target = os.path.normpath(os.path.join(STATIC_DIR, clean_path))
            if target.startswith(STATIC_DIR) and os.path.isfile(target):
                file_path = target
            else:
                file_path = os.path.join(STATIC_DIR, "index.html")

        if not os.path.exists(file_path):
            self.send_response(404)
            self._set_security_headers("text/plain")
            self.end_headers()
            self.wfile.write(b"File not found")
            return

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type:
            mime_type = "text/plain"

        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self._set_security_headers(mime_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_response(500)
            self._set_security_headers("text/plain")
            self.end_headers()
            self.wfile.write(b"Internal server error reading static asset")

    def do_POST(self):
        clean_path = self.path.split("?")[0]

        # Read and validate request body
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length <= 0 or content_length > 16384:
                self.send_response(400)
                self._set_security_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Payload too large or empty"}).encode("utf-8"))
                return

            raw_body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(raw_body)
            prompt = data.get("prompt", "").strip()
            enable_inbound = bool(data.get("enable_inbound", True))
            enable_outbound = bool(data.get("enable_outbound", True))
            if not prompt or len(prompt) > 4096:
                self.send_response(400)
                self._set_security_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Prompt must be between 1 and 4096 characters"}).encode("utf-8"))
                return
        except Exception:
            self.send_response(400)
            self._set_security_headers("application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON input"}).encode("utf-8"))
            return

        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt}
                    ]
                }
            ]
        }
        encoded_payload = json.dumps(payload).encode("utf-8")

        if clean_path.endswith("/api/no-streaming"):
            self._handle_no_streaming(encoded_payload, enable_inbound, enable_outbound)
        elif clean_path.endswith("/api/streaming-sse"):
            self._handle_streaming_sse(encoded_payload, enable_inbound, enable_outbound)
        else:
            self.send_response(404)
            self._set_security_headers("application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def _handle_no_streaming(self, encoded_payload, enable_inbound=True, enable_outbound=True):
        start_time = time.time()
        headers = {
            "Content-Type": "application/json",
            "x-inbound": "enable" if enable_inbound else "disable",
            "x-outbound": "enable" if enable_outbound else "disable",
        }
        req = urllib.request.Request(
            NO_STREAMING_URL,
            data=encoded_payload,
            headers=headers
        )

        try:
            with urllib.request.urlopen(req, context=ssl_ctx, timeout=60) as resp:
                elapsed_ms = int((time.time() - start_time) * 1000)
                body = resp.read().decode("utf-8")
                status = resp.status
                self.send_response(200)
                self._set_security_headers("application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": status,
                    "elapsed_ms": elapsed_ms,
                    "blocked": False,
                    "raw_response": json.loads(body)
                }).encode("utf-8"))
        except urllib.error.HTTPError as e:
            elapsed_ms = int((time.time() - start_time) * 1000)
            err_body = e.read().decode("utf-8")
            try:
                parsed_err = json.loads(err_body)
            except Exception:
                parsed_err = {"raw": err_body}

            is_blocked = (e.code == 400 and "FilterMatched" in err_body)
            self.send_response(200)
            self._set_security_headers("application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": e.code,
                "elapsed_ms": elapsed_ms,
                "blocked": is_blocked,
                "error": parsed_err
            }).encode("utf-8"))
        except Exception as e:
            elapsed_ms = int((time.time() - start_time) * 1000)
            self.send_response(500)
            self._set_security_headers("application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": 500,
                "elapsed_ms": elapsed_ms,
                "error": {"message": str(e)}
            }).encode("utf-8"))

    def _handle_streaming_sse(self, encoded_payload, enable_inbound=True, enable_outbound=True):
        start_time = time.time()
        headers = {
            "Content-Type": "application/json",
            "x-inbound": "enable" if enable_inbound else "disable",
            "x-outbound": "enable" if enable_outbound else "disable",
        }
        req = urllib.request.Request(
            STREAMING_SSE_URL,
            data=encoded_payload,
            headers=headers
        )

        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()

            with urllib.request.urlopen(req, context=ssl_ctx, timeout=60) as resp:
                first_chunk = True
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    
                    if first_chunk and line.startswith(b"data:"):
                        first_chunk = False
                        ttft_ms = int((time.time() - start_time) * 1000)
                        # Inject TTFT metadata event to client
                        meta_event = f"event: ttft\ndata: {json.dumps({'ttft_ms': ttft_ms})}\n\n".encode("utf-8")
                        self.wfile.write(meta_event)
                        self.wfile.flush()

                    self.wfile.write(line)
                    self.wfile.flush()

            # End of stream event
            total_ms = int((time.time() - start_time) * 1000)
            end_event = f"event: done\ndata: {json.dumps({'total_ms': total_ms, 'done': True})}\n\n".encode("utf-8")
            self.wfile.write(end_event)
            self.wfile.flush()

        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            err_event = f"event: error\ndata: {json.dumps({'status': e.code, 'body': err_body})}\n\n".encode("utf-8")
            self.wfile.write(err_event)
            self.wfile.flush()
        except Exception as e:
            err_event = f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n".encode("utf-8")
            self.wfile.write(err_event)
            self.wfile.flush()
        finally:
            self.close_connection = True


def run():
    server_address = (HOST, PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, DemoHandler)
    print(f"Apigee Model Armor Demo UI running on http://{HOST}:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()

if __name__ == "__main__":
    run()
