# Local Infrastructure Stack

## Components

- Kafka (KRaft)
- Schema Registry
- Kafka UI
- PostgreSQL
- Redis
- Prometheus
- Grafana

## Suggested local ports

- Kafka broker: `9092`
- Schema Registry: `8081`
- Kafka UI: `8080`
- Postgres: `5432`
- Redis: `6379`
- Prometheus: `9090`
- Grafana: `3000`

## Docker compose notes

- Use named volumes for Kafka and Postgres persistence.
- Put all services in one dedicated network (`kafka-practice-net`).
- Add healthchecks and startup dependencies.
- Keep env values in `.env` and provide `.env.example`.

## Minimal env vars

- `KAFKA_BROKERS`
- `SCHEMA_REGISTRY_URL`
- `POSTGRES_URL`
- `REDIS_URL`
- `APP_ENV`
- `LOG_LEVEL`
