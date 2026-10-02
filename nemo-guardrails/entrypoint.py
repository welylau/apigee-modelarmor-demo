#!/usr/bin/env python3
"""
NVIDIA NeMo Guardrails Cloud Run Entrypoint (Option A - CPU Orchestrator)
=========================================================================
Starts:
1. A lightweight, localhost-only (127.0.0.1:8081) OpenAI-compatible bridge
   that translates NeMo Guardrails `engine: openai` calls into Google Cloud
   Vertex AI Gemini `:generateContent` calls using Application Default
   Credentials (ADC).
2. The official NVIDIA NeMo Guardrails FastAPI Server (`nemoguardrails.server.api:app`)
   on $PORT (default 8080) with all configured Guardrail Catalog profiles.

Security Notes:
- Internal bridge binds strictly to 127.0.0.1 (never 0.0.0.0).
- Uses dynamic GCP IAM / Metadata Server OAuth2 tokens (no hardcoded secrets).
- Enforces strict request size limits and method allow-listing.
"""

import http.server
import json
import logging
import os
import socketserver
import sys
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import google.auth
import google.auth.transport.requests
import requests
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("nemo-entrypoint")

INTERNAL_BRIDGE_HOST = "127.0.0.1"
INTERNAL_BRIDGE_PORT = int(os.environ.get("INTERNAL_BRIDGE_PORT", "8081"))
SERVER_PORT = int(os.environ.get("PORT", "8080"))
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "YOUR_GCP_PROJECT_ID")
MAX_BODY_BYTES = 1_048_576  # 1 MiB limit against DoS payloads

VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "global")
VERTEX_MODEL = os.environ.get("VERTEX_MODEL", "gemini-2.5-flash-lite")
VERTEX_FALLBACK_MODEL = os.environ.get("VERTEX_FALLBACK_MODEL", "gemini-2.0-flash")


def _vertex_url(location: str, model: str) -> str:
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return (
        f"https://{host}/v1/projects/{GCP_PROJECT_ID}/locations/{location}"
        f"/publishers/google/models/{model}:generateContent"
    )


# Candidate Vertex AI Gemini (judge LLM) endpoints in priority order:
# primary location first, then global fallback model, then us-central1 as last resort.
VERTEX_CANDIDATE_URLS = list(dict.fromkeys([
    _vertex_url(VERTEX_LOCATION, VERTEX_MODEL),
    _vertex_url(VERTEX_LOCATION, VERTEX_FALLBACK_MODEL),
    _vertex_url("us-central1", VERTEX_MODEL),
]))


class VertexTokenManager:
    """Thread-safe Google Cloud ADC token provider."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._creds: Optional[Any] = None
        self._auth_req = google.auth.transport.requests.Request()
        self._preferred_url: Optional[str] = None

    def get_token(self) -> str:
        with self._lock:
            if self._creds is None:
                self._creds, _ = google.auth.default(
                    scopes=["https://www.googleapis.com/auth/cloud-platform"]
                )
            if not self._creds.valid or self._creds.expired or not self._creds.token:
                self._creds.refresh(self._auth_req)
            return str(self._creds.token)

    def get_candidate_urls(self) -> List[str]:
        with self._lock:
            if self._preferred_url:
                others = [u for u in VERTEX_CANDIDATE_URLS if u != self._preferred_url]
                return [self._preferred_url] + others
            return list(VERTEX_CANDIDATE_URLS)

    def set_preferred_url(self, url: str) -> None:
        with self._lock:
            self._preferred_url = url


token_manager = VertexTokenManager()
http_session = requests.Session()


def openai_messages_to_gemini(
    messages: List[Dict[str, Any]],
    temperature: float = 0.1,
    max_tokens: int = 1024,
    stop: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Converts OpenAI Chat Completions messages into a Vertex AI Gemini payload."""
    system_parts: List[str] = []
    contents: List[Dict[str, Any]] = []

    for msg in messages:
        role = str(msg.get("role", "user")).lower()
        content = msg.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                str(part.get("text", "")) for part in content if isinstance(part, dict)
            )
        text = str(content or "").strip()
        if not text:
            continue

        if role == "system":
            system_parts.append(text)
        elif role == "assistant":
            gemini_role = "model"
            if contents and contents[-1]["role"] == gemini_role:
                contents[-1]["parts"][0]["text"] += "\n" + text
            else:
                contents.append({"role": gemini_role, "parts": [{"text": text}]})
        else:
            gemini_role = "user"
            if contents and contents[-1]["role"] == gemini_role:
                contents[-1]["parts"][0]["text"] += "\n" + text
            else:
                contents.append({"role": gemini_role, "parts": [{"text": text}]})

    # Gemini requires at least one user content message
    if not contents and system_parts:
        contents.append({"role": "user", "parts": [{"text": "\n\n".join(system_parts)}]})
        system_parts = []
    elif not contents:
        contents.append({"role": "user", "parts": [{"text": "Hello"}]})

    # Ensure the first turn is a user message
    if contents[0]["role"] != "user":
        contents.insert(0, {"role": "user", "parts": [{"text": "Continue conversation:"}]})

    gen_config: Dict[str, Any] = {
        "temperature": float(temperature) if temperature is not None else 0.1,
        "maxOutputTokens": int(max_tokens) if max_tokens is not None else 1024,
    }
    if stop:
        if isinstance(stop, str):
            stop = [stop]
        gen_config["stopSequences"] = [str(s) for s in stop[:5] if s]

    payload: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": gen_config,
        # Allow Gemini to evaluate adversarial prompts during NeMo Guardrails
        # safety/topic/self-check tasks without refusing the classifier prompt itself.
        "safetySettings": [
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
        ],
    }

    if system_parts:
        payload["systemInstruction"] = {
            "parts": [{"text": "\n\n".join(system_parts)}]
        }

    return payload


def call_vertex_gemini(gemini_payload: Dict[str, Any]) -> Tuple[str, Dict[str, int]]:
    """Calls Vertex AI Gemini and extracts the generated text and token usage."""
    token = token_manager.get_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    last_err = "Unknown Vertex AI error"
    for url in token_manager.get_candidate_urls():
        try:
            resp = http_session.post(url, headers=headers, json=gemini_payload, timeout=30)
            if resp.status_code == 200:
                token_manager.set_preferred_url(url)
                data = resp.json()
                candidates = data.get("candidates", [])
                text_parts: List[str] = []
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    for p in parts:
                        if "text" in p:
                            text_parts.append(str(p["text"]))
                output_text = "".join(text_parts).strip()
                usage_meta = data.get("usageMetadata", {})
                usage = {
                    "prompt_tokens": int(usage_meta.get("promptTokenCount", 0)),
                    "completion_tokens": int(usage_meta.get("candidatesTokenCount", 0)),
                    "total_tokens": int(usage_meta.get("totalTokenCount", 0)),
                }
                return output_text, usage
            last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
            log.warning("Vertex candidate %s returned %s", url, last_err)
        except Exception as exc:
            last_err = str(exc)
            log.warning("Vertex candidate %s failed: %s", url, last_err)

    raise RuntimeError(f"All Vertex AI endpoints failed. Last error: {last_err}")


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class VertexOpenAIBridgeHandler(http.server.BaseHTTPRequestHandler):
    """Localhost-only OpenAI Chat Completions bridge backed by Vertex AI Gemini."""

    def log_message(self, fmt: str, *args: Any) -> None:
        # Suppress noisy per-call access logs or keep minimal without secrets
        pass

    def _send_json(self, payload: Dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path.startswith("/v1/models"):
            self._send_json(
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "gemini-2.5-flash-lite",
                            "object": "model",
                            "created": int(time.time()),
                            "owned_by": "google-vertex-ai",
                        }
                    ],
                }
            )
            return
        self._send_json({"status": "ok", "bridge": "vertex-openai-local"}, status=200)

    def do_POST(self) -> None:
        if not self.path.startswith("/v1/chat/completions"):
            self._send_json({"error": {"message": "Not found", "type": "invalid_request_error"}}, status=404)
            return

        content_len = int(self.headers.get("Content-Length", "0"))
        if content_len <= 0 or content_len > MAX_BODY_BYTES:
            self._send_json(
                {"error": {"message": "Invalid request payload size", "type": "invalid_request_error"}},
                status=400,
            )
            return

        try:
            body = json.loads(self.rfile.read(content_len).decode("utf-8"))
        except Exception:
            self._send_json(
                {"error": {"message": "Malformed JSON body", "type": "invalid_request_error"}},
                status=400,
            )
            return

        messages = body.get("messages", [])
        model_name = str(body.get("model", "gemini-2.5-flash-lite"))
        temperature = body.get("temperature", 0.1)
        max_tokens = body.get("max_tokens") or body.get("max_completion_tokens") or 1024
        stop = body.get("stop")
        stream = bool(body.get("stream", False))

        try:
            gemini_payload = openai_messages_to_gemini(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stop=stop,
            )
            text, usage = call_vertex_gemini(gemini_payload)
        except Exception as exc:
            log.error("Bridge inference error: %s", exc)
            self._send_json(
                {"error": {"message": "Upstream model inference failed", "type": "server_error"}},
                status=502,
            )
            return

        completion_id = f"chatcmpl-{uuid.uuid4().hex[:16]}"
        created_ts = int(time.time())

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()

            chunk_payload = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model_name,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": text},
                        "finish_reason": None,
                    }
                ],
            }
            stop_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model_name,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }
                ],
            }
            self.wfile.write(f"data: {json.dumps(chunk_payload)}\n\n".encode("utf-8"))
            self.wfile.write(f"data: {json.dumps(stop_chunk)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        response_payload = {
            "id": completion_id,
            "object": "chat.completion",
            "created": created_ts,
            "model": model_name,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": text,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": usage,
        }
        self._send_json(response_payload, status=200)


def start_internal_bridge() -> ThreadedHTTPServer:
    server = ThreadedHTTPServer((INTERNAL_BRIDGE_HOST, INTERNAL_BRIDGE_PORT), VertexOpenAIBridgeHandler)
    thread = threading.Thread(target=server.serve_forever, name="vertex-openai-bridge", daemon=True)
    thread.start()
    log.info(
        "Started internal Vertex AI OpenAI-compatible bridge on http://%s:%d/v1",
        INTERNAL_BRIDGE_HOST,
        INTERNAL_BRIDGE_PORT,
    )
    return server


def configure_app() -> Any:
    from nemoguardrails.server import api as nemo_api
    from configs.config import SecurityHeadersMiddleware

    configs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "configs")
    nemo_api.app.rails_config_path = configs_dir
    nemo_api.app.default_config_id = "default"
    nemo_api.app.add_middleware(SecurityHeadersMiddleware)
    return nemo_api.app, configs_dir


def main() -> None:
    log.info("Judge LLM: model=%s location=%s primary=%s", VERTEX_MODEL, VERTEX_LOCATION, VERTEX_CANDIDATE_URLS[0])
    start_internal_bridge()
    app, configs_dir = configure_app()

    # Note: In Cloud Run containers, the external server must bind to 0.0.0.0:$PORT
    # to receive traffic from the Cloud Run ingress proxy. When local testing is
    # desired, set HOST=127.0.0.1.
    bind_host = os.environ.get("HOST", "0.0.0.0")
    log.info(
        "Starting NVIDIA NeMo Guardrails Server on %s:%d (configs=%s, default=%s)",
        bind_host,
        SERVER_PORT,
        configs_dir,
        app.default_config_id,
    )
    uvicorn.run(app, host=bind_host, port=SERVER_PORT, log_level="info")


if __name__ == "__main__":
    main()

