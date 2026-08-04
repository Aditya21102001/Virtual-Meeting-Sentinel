# Hugging Face Spaces (Docker SDK) and local docker-compose both build this.
FROM python:3.11-slim

# OMP_NUM_THREADS: ONNX Runtime and OpenMP otherwise start one worker thread per HOST core, which
# inside a container with a fractional CPU share means many threads competing for a fraction of one,
# each carrying its own allocation arena. Embedding a handful of sentences needs no parallelism.
#
# FASTEMBED_CACHE_PATH matters more than it looks: fastembed caches downloaded models under a
# temporary directory by default, which would put the model outside the image layers — so the
# build-time download below would be discarded and every cold start would re-fetch it from the
# network, or fail outright on a host without egress.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/hf_cache \
    FASTEMBED_CACHE_PATH=/app/hf_cache \
    OMP_NUM_THREADS=1 \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app

# System deps for faiss / psycopg builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# No Torch here, deliberately. Embeddings run on ONNX Runtime (see app/embeddings.py), so nothing
# in this image pulls the PyTorch wheel — which on Linux is the CUDA build, over a gigabyte of
# nvidia-* libraries for a host with no GPU, and ~310 MB resident once imported.
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the embedding model at build time so cold starts are fast and offline-safe.
RUN python -c "from fastembed import TextEmbedding; \
    TextEmbedding('sentence-transformers/all-MiniLM-L6-v2')"

COPY . .

# HF Spaces expects the app on port 7860; locally we use 8000. Honour $PORT if set.
ENV PORT=8000
EXPOSE 8000 7860
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
