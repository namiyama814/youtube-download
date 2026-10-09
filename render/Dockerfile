FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY render/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY render/app.py render/download.py ./
RUN useradd --create-home downloader
USER downloader
ENV PYTHONUNBUFFERED=1 PORT=10000
EXPOSE 10000
CMD ["python", "app.py"]
