FROM node:26-bookworm-slim AS provider
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev && rm -rf /var/lib/apt/lists/*
# Match the pinned Python plugin and verify the upstream commit.
RUN git clone --depth 1 --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/provider && test "$(git -C /opt/provider rev-parse HEAD)" = "26475e9d3665b972c4aeb83b4dbaafcf64b88438"
WORKDIR /opt/provider/server
RUN npm ci --no-audit --no-fund && npx tsc && npm prune --omit=dev

FROM python:3.12-slim-bookworm
COPY --from=provider /usr/local/bin/node /usr/local/bin/node
COPY --from=provider /opt/provider/server /opt/bgutil
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY render/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY render/app.py render/download.py ./
RUN useradd --create-home downloader
USER downloader
ENV PYTHONUNBUFFERED=1 PORT=10000 BGUTIL_SERVER_HOME=/opt/bgutil
EXPOSE 10000
CMD ["python", "app.py"]
