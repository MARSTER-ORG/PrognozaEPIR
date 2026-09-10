FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dedicated image: only the OPERA CMAX proxy, no bulletin ingestor.
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python", "/app/server.py"]
