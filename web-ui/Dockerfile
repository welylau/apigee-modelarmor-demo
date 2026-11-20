FROM python:3.11-slim

WORKDIR /app

# Stdlib only: no pip install. Runtime data and secrets are excluded via
# .dockerignore (.env, audit_logs.json).
COPY server.py /app/server.py
COPY pdf_text.py /app/pdf_text.py
COPY static /app/static

RUN useradd --create-home --uid 10001 appuser && chown -R appuser /app
USER 10001

# Inside a container the server must listen on all interfaces; Cloud Run is
# protected by IAP. API_KEY comes from Secret Manager (--set-secrets), never the image.
ENV HOST=0.0.0.0
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["python3", "server.py"]
