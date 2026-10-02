FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    HOST=0.0.0.0 \
    GCP_PROJECT_ID=YOUR_GCP_PROJECT_ID \
    NEMO_GUARDRAILS_DISABLE_CHAT_UI=true \
    HOME=/tmp

WORKDIR /app

# Install minimal build tools for yara-python if needed, then clean up in same layer
COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ \
    && pip install --no-cache-dir -r requirements.txt \
    && python3 -m spacy download en_core_web_sm \
    && find /usr/local/lib -type f \( -name "*.py" -o -name "*.yaml" -o -name "*.yml" \) \
       -exec sed -i 's/en_core_web_lg/en_core_web_sm/g' {} + \
    && apt-get purge -y --auto-remove gcc g++ \
    && rm -rf /var/lib/apt/lists/* /root/.cache

COPY entrypoint.py .
COPY configs/ ./configs/

# Validate Presidio + spaCy small model, all Guardrail Catalog YAML configs, and FastAPI lifespan at build time
RUN python3 -c "import os; from nemoguardrails import RailsConfig; from nemoguardrails.library.sensitive_data_detection.actions import _get_analyzer; _get_analyzer(); [RailsConfig.from_path(f'/app/configs/{d}') for d in os.listdir('/app/configs') if os.path.isdir(f'/app/configs/{d}') and not d.startswith('_')]; from starlette.testclient import TestClient; from entrypoint import configure_app; app, _ = configure_app(); client = TestClient(app); client.__enter__(); r1 = client.get('/v1/rails/configs'); assert r1.status_code == 200, r1.text; r2 = client.get('/v1/guardrails/catalog'); assert r2.status_code == 200, r2.text; client.__exit__(None, None, None); print('All Guardrail Catalog configs and FastAPI lifespan validated successfully!')"

EXPOSE 8080

CMD ["python3", "entrypoint.py"]

