FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

COPY app.py .
COPY audit_logs.json* .
COPY static/ ./static/

EXPOSE 8080

CMD ["python3", "app.py"]
