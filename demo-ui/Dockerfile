FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8080 \
    HOST=0.0.0.0

# Run as an unprivileged user. It owns /app because app.py writes audit_logs.json there.
RUN useradd --create-home --uid 10001 appuser

WORKDIR /app

COPY --chown=appuser:appuser app.py .
COPY --chown=appuser:appuser audit_logs.json* .
COPY --chown=appuser:appuser static/ ./static/

RUN chown appuser:appuser /app

USER appuser

EXPOSE 8080

# APIGEE_API_KEY is injected at runtime from Secret Manager (never baked into the image).
CMD ["python3", "app.py"]
