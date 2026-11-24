FROM golang:1.27.3-alpine3.24@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS go-base
WORKDIR /src

FROM go-base AS tools
RUN apk add --no-cache build-base ffmpeg sqlite

FROM node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
COPY worker/package.json ./worker/package.json
RUN node -e "const u=require('./worker/package.json').aaa_muse_update; if(u.contract!=='native-cron-v1'||!/^([1-9][0-9]*(,[1-9][0-9]*)*)?$/.test(u.from_majors)) process.exit(1); process.stdout.write(u.from_majors)" > /tmp/worker-update-from
COPY portal/package.json ./portal/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY portal/index.html portal/tsconfig.json ./portal/
COPY portal/src ./portal/src
ARG SOURCE_SHA=development
RUN npm run check --workspace portal && VITE_SOURCE_SHA=${SOURCE_SHA} npm run build --workspace portal

FROM go-base AS build
COPY go.mod go.sum ./
RUN go mod download \
    && mkdir -p /out/sqlite-licenses /out/mcp-licenses /out/image-licenses /out/mimetype-licenses \
    && cp "$(go list -m -f '{{.Dir}}' modernc.org/sqlite)"/LICENSE* /out/sqlite-licenses/ \
    && cp "$(go list -m -f '{{.Dir}}' github.com/modelcontextprotocol/go-sdk)"/LICENSE /out/mcp-licenses/ \
    && cp "$(go list -m -f '{{.Dir}}' golang.org/x/image)"/LICENSE /out/image-licenses/ \
    && cp "$(go list -m -f '{{.Dir}}' github.com/gabriel-vasile/mimetype)"/LICENSE /out/mimetype-licenses/
COPY cmd ./cmd
COPY internal ./internal
COPY --from=frontend /tmp/worker-update-from /tmp/worker-update-from
ARG SOURCE_SHA=development
ARG SOURCE_DIRTY=true
ARG PRODUCT_VERSION=1.0.0-dev.0
ARG WORKER_SHA256
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.revision=${SOURCE_SHA} -X main.dirty=${SOURCE_DIRTY} -X main.version=${PRODUCT_VERSION} -X main.workerSHA256=${WORKER_SHA256} -X main.workerUpdateFrom=$(cat /tmp/worker-update-from)" -o /out/service ./cmd/service

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime-files
RUN mkdir -p /rootfs/etc/aaa-muse-ai /rootfs/tmp /rootfs/var/lib/aaa-muse-ai/state \
        /rootfs/var/lib/aaa-muse-ai/diagnostics /rootfs/var/lib/aaa-muse-ai/media \
    && cp /etc/alpine-release /rootfs/etc/ \
    && cp -L /etc/os-release /rootfs/etc/os-release \
    && chmod 1777 /rootfs/tmp \
    && chown 10001:10001 /rootfs/var/lib/aaa-muse-ai/* \
    && chmod 0700 /rootfs/var/lib/aaa-muse-ai/*

FROM scratch AS runtime
COPY --from=runtime-files /rootfs/ /
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/service /usr/local/bin/service
COPY --from=build /out/sqlite-licenses/ /usr/share/aaa-muse-ai/licenses/sqlite/
COPY --from=build /out/mcp-licenses/ /usr/share/aaa-muse-ai/licenses/mcp-go-sdk/
COPY --from=build /out/image-licenses/ /usr/share/aaa-muse-ai/licenses/x-image/
COPY --from=build /out/mimetype-licenses/ /usr/share/aaa-muse-ai/licenses/mimetype/
COPY --from=frontend /src/portal/dist /usr/share/aaa-muse-ai/portal
COPY --from=frontend /src/node_modules/@fontsource/geist/LICENSE /usr/share/aaa-muse-ai/licenses/geist-OFL.txt
COPY --from=frontend /src/node_modules/@fontsource/geist-mono/LICENSE /usr/share/aaa-muse-ai/licenses/geist-mono-OFL.txt
ARG SOURCE_SHA=development
ARG SOURCE_DIRTY=true
ARG PRODUCT_VERSION=1.0.0-dev.0
LABEL org.opencontainers.image.source="https://github.com/markhuangai/AaA-muse-ai" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="${PRODUCT_VERSION}" \
      io.aaa-muse.source-dirty="${SOURCE_DIRTY}"
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/service"]
