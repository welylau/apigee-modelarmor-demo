"""
Server-level initialization for NVIDIA NeMo Guardrails on Cloud Run.
Loaded automatically by `nemoguardrails.server.api` during lifespan startup.
"""

from typing import Any, Dict, List
from fastapi import FastAPI, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


CATALOG_PROFILES: List[Dict[str, Any]] = [
    {
        "id": "default",
        "name": "Unified Guardrail Catalog Suite (Defense-in-Depth)",
        "catalog_categories": [
            "Content Safety",
            "Topic Control",
            "LLM Self-Check (Jailbreak & Output)",
            "PII Detection & Masking (Presidio)",
            "Agentic Security (Context Bloat & YARA Injection Detection)",
        ],
        "gpu_required": False,
        "input_flows": [
            "context bloat detection on input",
            "mask sensitive data on input",
            "self check input",
            "content safety check input $model=content_safety",
            "topic safety check input $model=topic_control",
        ],
        "output_flows": [
            "injection detection",
            "mask sensitive data on output",
            "content safety check output $model=content_safety",
            "self check output",
        ],
    },
    {
        "id": "content_safety",
        "name": "Content Safety Guardrail",
        "catalog_url": "https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/content-safety",
        "gpu_required": False,
        "description": "Evaluates user inputs and LLM outputs against safety taxonomy (Violence, Hate Speech, Criminal Planning, Weapons, Self-Harm, Malware, Harassment).",
        "input_flows": ["content safety check input $model=content_safety"],
        "output_flows": ["content safety check output $model=content_safety"],
    },
    {
        "id": "topic_control",
        "name": "Topic Control & Domain Boundary Guardrail",
        "catalog_url": "https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/topic-control",
        "gpu_required": False,
        "description": "Enforces strict conversation boundaries (allows Cloud/AI/Enterprise/Math/Tech queries; blocks investment advice, medical prescriptions, partisan politics, and competitor bashing).",
        "input_flows": ["topic safety check input $model=topic_control"],
        "output_flows": [],
    },
    {
        "id": "jailbreak_self_check",
        "name": "Jailbreak & Prompt Injection Self-Check",
        "catalog_url": "https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/self-check",
        "gpu_required": False,
        "description": "Detects adversarial jailbreaks (DAN, instruction overrides, system prompt extraction) on input and moderates bot responses on output.",
        "input_flows": ["self check input"],
        "output_flows": ["self check output"],
    },
    {
        "id": "pii_masking",
        "name": "PII Detection & Masking (Microsoft Presidio)",
        "catalog_url": "https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/pii-detection",
        "gpu_required": False,
        "description": "Locally detects and masks PERSON, EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, and US_SSN on both input and output using Presidio + spaCy.",
        "input_flows": ["mask sensitive data on input"],
        "output_flows": ["mask sensitive data on output"],
    },
    {
        "id": "agentic_security",
        "name": "Agentic Security (YARA Injection & Context Bloat Detection)",
        "catalog_url": "https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/agentic-security",
        "gpu_required": False,
        "description": "Model-free local defense: blocks context-stuffing/entropy attacks on input and blocks SQLi, XSS, Python code injection, and Jinja template injection on output via YARA rules.",
        "input_flows": ["context bloat detection on input"],
        "output_flows": ["injection detection"],
    },
]


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Applies mandatory security headers to all HTTP responses."""

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        # Restrict HTTP methods to GET, POST, OPTIONS, HEAD
        if request.method not in ("GET", "POST", "OPTIONS", "HEAD"):
            return JSONResponse(
                {"error": {"message": "Method not allowed", "type": "invalid_request_error"}},
                status_code=405,
            )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; frame-ancestors 'none'; object-src 'none';"
        )
        return response


def init(app: FastAPI) -> None:
    """Initializes server-level settings and catalog discovery routes."""
    app.default_config_id = "default"

    # TODO(security): Authentication and rate-limiting are enforced at the Google Cloud Run
    # IAM / Apigee API Gateway perimeter rather than via cookie sessions or local DB auth.

    @app.get("/health", tags=["Health"])
    async def health_check() -> JSONResponse:
        return JSONResponse({"status": "ok", "service": "nemo-guardrails"})

    @app.get("/v1/guardrails/catalog", tags=["Guardrail Catalog"])
    async def get_guardrail_catalog() -> JSONResponse:
        return JSONResponse(
            {
                "service": "nemo-guardrails",
                "deployment_mode": "Option A (Cloud Run CPU Orchestrator + Vertex AI Gemini)",
                "default_config_id": app.default_config_id,
                "profiles": CATALOG_PROFILES,
            }
        )


