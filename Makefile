SHELL := /bin/bash

.PHONY: up up-phase1 down logs migrate topics install dev-order-api dev-outbox smoke-phase1

up:
	docker compose up -d kafka schema-registry kafka-ui postgres redis

up-phase1:
	DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose --profile phase1 up -d --build order-api outbox-publisher

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

smoke-phase1:
	./scripts/smoke-phase1.sh
