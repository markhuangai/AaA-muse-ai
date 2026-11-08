FROM golang:1.27.3-alpine3.24@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS tools
RUN apk add --no-cache build-base
WORKDIR /src

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
ARG SOURCE_SHA=development
ARG SOURCE_DIRTY=true
LABEL org.opencontainers.image.source="https://github.com/markhuangai/AaA-muse-ai" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      io.aaa-muse.source-dirty="${SOURCE_DIRTY}"
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/service"]
