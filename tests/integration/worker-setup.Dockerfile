FROM node:24.22.2-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates
WORKDIR /home/worker
