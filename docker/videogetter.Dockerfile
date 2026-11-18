FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o vidara-server .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/vidara-server .
COPY data ./data
COPY data.json ./data.json
ENV PORT=8088
EXPOSE 8088
CMD ["./vidara-server"]
