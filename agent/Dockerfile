FROM golang:1.25-bookworm AS build
ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/sysfnos-agent ./main.go

FROM scratch AS artifact
COPY --from=build /out/sysfnos-agent /sysfnos-agent
