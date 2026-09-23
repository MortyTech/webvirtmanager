# syntax=docker/dockerfile:1.6

# ===========================================================================
# Stage 1 — build the React + TypeScript frontend (Vite)
# ===========================================================================
FROM oven/bun:1 AS frontend
WORKDIR /build
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

# ===========================================================================
# Stage 2 — build Python deps (libvirt-python needs the libvirt headers + gcc)
# ===========================================================================
FROM python:3.12-slim AS backend-build
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        libvirt-dev build-essential gcc pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && LIBVIRT_VER="$(pkg-config --modversion libvirt)" \
    && echo ">>> installing libvirt-python matching libvirt ${LIBVIRT_VER}" \
    && pip install --no-cache-dir "libvirt-python==${LIBVIRT_VER}"

# ===========================================================================
# Stage 3 — runtime image (lean: only libvirt runtime libs + openssh)
# ===========================================================================
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    CONFIG_PATH=/app/config.ini \
    STATIC_DIR=/app/static \
    PATH="/opt/venv/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
        libvirt0 \
        libxml2 \
        libgnutls30 \
        libsasl2-2 \
        libyajl2 \
        openssh-client \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python virtualenv (with compiled libvirt-python)
COPY --from=backend-build /opt/venv /opt/venv

WORKDIR /app
COPY backend/app ./app
COPY backend/config.ini.example ./config.ini.example
# Compiled frontend served as static assets by FastAPI.
COPY --from=frontend /build/dist ./static

# Default config (can be overridden by mounting a volume at /app/config.ini).
RUN cp -n config.ini.example config.ini

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).read(); sys.exit(0)" || exit 1

# Single worker: the app uses an in-memory session store for OIDC sessions.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
