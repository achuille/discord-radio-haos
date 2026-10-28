# Multi-architecture upstream image: amd64 and arm64. No HA/S6 base image.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ pkg-config libopus-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim
ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL io.hass.name="Discord Radio" \
      io.hass.description="Discord radio with native Home Assistant configuration" \
      io.hass.type="addon" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.arch="${BUILD_ARCH}"
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libopus0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY run.sh /run.sh
RUN chmod 755 /run.sh
# Supervisor supplies init and /data. No host port, device or API is required.
CMD ["/run.sh"]
