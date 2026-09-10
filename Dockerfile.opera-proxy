FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/opera_proxy_only.py /app/opera_proxy_only.py

EXPOSE 8080
CMD ["python", "/app/opera_proxy_only.py"]
