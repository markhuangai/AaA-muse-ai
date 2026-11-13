FROM golang:1.27.3-alpine3.24@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS tools
RUN apk add --no-cache build-base
WORKDIR /src

FROM node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
COPY worker/package.json ./worker/package.json
COPY portal/package.json ./portal/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY portal/index.html portal/tsconfig.json ./portal/
COPY portal/src ./portal/src
ARG SOURCE_SHA=development
RUN npm run check --workspace portal && VITE_SOURCE_SHA=${SOURCE_SHA} npm run build --workspace portal

FROM tools AS build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG SOURCE_SHA=development
ARG SOURCE_DIRTY=true
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.revision=${SOURCE_SHA} -X main.dirty=${SOURCE_DIRTY}" -o /out/service ./cmd/service

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
RUN addgroup -g 10001 service && adduser -D -H -u 10001 -G service service \
    && mkdir -p /etc/aaa-muse-ai /var/lib/aaa-muse-ai/diagnostics \
    && chown service:service /var/lib/aaa-muse-ai/diagnostics \
    && chmod 0700 /var/lib/aaa-muse-ai/diagnostics
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/service /usr/local/bin/service
COPY --from=frontend /src/portal/dist /usr/share/aaa-muse-ai/portal
COPY --from=frontend /src/node_modules/@fontsource/geist/LICENSE /usr/share/aaa-muse-ai/licenses/geist-OFL.txt
COPY --from=frontend /src/node_modules/@fontsource/geist-mono/LICENSE /usr/share/aaa-muse-ai/licenses/geist-mono-OFL.txt
ARG SOURCE_SHA=development
ARG SOURCE_DIRTY=true
LABEL org.opencontainers.image.source="https://github.com/markhuangai/AaA-muse-ai" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      io.aaa-muse.source-dirty="${SOURCE_DIRTY}"
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/service"]
