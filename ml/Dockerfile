# The ML container: the enrollment service and the ingestion worker.
#
#   docker build -t faceapp-ml ml/
#   docker run -e DATABASE_URL=... -p 8000:8000 faceapp-ml service
#   docker run -e DATABASE_URL=... faceapp-ml worker
#
# One image, two roles, because they share the model and the quality gate and
# must never disagree about either. Scale them independently: service replicas
# for concurrent attendees, worker replicas for how fast an album is ready.
#
# This cannot be a serverless function. onnxruntime plus the buffalo_l pack is
# several hundred MB resident and seconds to load; paying that per request is
# both too slow for someone standing at an event and too expensive to run.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    INSIGHTFACE_HOME=/models

# onnxruntime needs libgomp; OpenCV, pulled in by insightface, needs libGL and
# libglib even headless.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgomp1 libgl1 libglib2.0-0 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before source, so editing a Python file does not reinstall
# onnxruntime.
COPY pyproject.toml ./
COPY faceapp_ml/__init__.py faceapp_ml/
RUN pip install --no-cache-dir ".[service,insightface]"

COPY . .
RUN pip install --no-cache-dir --no-deps -e .

# Bake the model into the image.
#
# Without this the first request after every deploy downloads ~280MB from
# GitHub: slow, and impossible on a host with locked-down egress. It also makes
# the image a fixed artifact — the model cannot change under a running
# deployment, so an eval report stays a statement about what is actually
# deployed rather than about whatever was downloaded that morning.
RUN python -c "from insightface.app import FaceAnalysis; \
FaceAnalysis(name='buffalo_l', \
             allowed_modules=['detection','recognition','landmark_3d_68'], \
             providers=['CPUExecutionProvider']).prepare(ctx_id=-1, det_size=(640,640))" \
 && find /models -name '*.zip' -delete

# Not root. Nothing here writes anything but temporary files.
RUN useradd --create-home --uid 10001 faceapp \
 && chown -R faceapp:faceapp /models /app
USER faceapp

ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["service"]
