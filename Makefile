SHELL := /bin/bash

.PHONY: up up-phase1 up-phase2 up-phase3 up-phase4 up-phase5 down logs migrate topics install dev-order-api dev-order-query-api dev-outbox dev-payment dev-inventory dev-status-updater smoke-phase1 smoke-phase2 smoke-phase3 smoke-phase4 schema-phase4

up:
	docker compose up -d kafka schema-registry kafka-ui postgres redis

up-phase1:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase1 up -d --build order-api outbox-publisher

up-phase2:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase2 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater

up-phase3:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase3 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater

up-phase4:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase4 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater

up-phase5:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase5 up -d --build order-api order-query-api outbox-publisher payment-worker inventory-worker order-status-updater prometheus grafana

down:
	docker compose down

logs:
	docker compose logs -f

migrate:
	./scripts/migrate.sh

topics:
	./scripts/create-topics.sh

install:
	npm install

dev-order-api:
	npm run dev:order-api

dev-order-query-api:
	npm run dev:order-query-api

dev-outbox:
	npm run dev:outbox

dev-payment:
	npm run dev:payment

dev-inventory:
	npm run dev:inventory

dev-status-updater:
	npm run dev:status-updater

smoke-phase1:
	./scripts/smoke-phase1.sh

smoke-phase2:
	./scripts/smoke-phase2.sh

smoke-phase3:
	./scripts/smoke-phase3.sh

smoke-phase4:
	./scripts/smoke-phase4.sh

schema-phase4:
	./scripts/schema-registry-phase4.sh
