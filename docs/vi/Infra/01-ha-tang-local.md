# Hạ Tầng Local

## Thành phần

- Kafka (KRaft)
- Schema Registry
- Kafka UI
- PostgreSQL
- Redis
- Prometheus
- Grafana

## Cổng local gợi ý

- Kafka broker: `9092`
- Schema Registry: `8081`
- Kafka UI: `8080`
- Postgres: `5432`
- Redis: `6379`
- Prometheus: `9090`
- Grafana: `3002`

## Lưu ý docker compose

- Dùng named volumes cho Kafka và Postgres để giữ dữ liệu.
- Giữ `prometheus` và `grafana` trong profile `phase5`.
- Thêm healthcheck và startup dependency.
- Quản lý biến môi trường trong `.env` và cung cấp `.env.example`.

## Cách khởi động Phase 5

```bash
make up-phase5
```

## Biến môi trường tối thiểu

- `KAFKA_BROKERS`
- `SCHEMA_REGISTRY_URL`
- `POSTGRES_URL`
- `REDIS_URL`
- `APP_ENV`
- `LOG_LEVEL`
