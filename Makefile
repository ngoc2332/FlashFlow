SHELL := /bin/bash

.PHONY: up up-phase1 up-phase2 down logs migrate topics install dev-order-api dev-outbox dev-payment smoke-phase1 smoke-phase2

up:
	docker compose up -d kafka schema-registry kafka-ui postgres redis

up-phase1:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase1 up -d --build order-api outbox-publisher

up-phase2:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase2 up -d --build order-api outbox-publisher payment-worker

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

dev-outbox:
	npm run dev:outbox

dev-payment:
	npm run dev:payment

smoke-phase1:
	./scripts/smoke-phase1.sh

smoke-phase2:
	./scripts/smoke-phase2.sh
