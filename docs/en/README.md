# Kafka Practice Project Docs (EN)

Project: **Realtime E-commerce Event Platform (Flash Sale)**

This docs set is optimized for:
- learning Kafka core and advanced features quickly (few days)
- building a production-like local system for vibe coding
- preparing strong interview stories for big tech / remote roles

## Architecture approach

- `DDD`: model bounded contexts, aggregates, invariants, and ubiquitous language.
- `EDD`: drive cross-service flows using explicit events and contracts.
- `Reliability`: enforce outbox, retries, DLQ, idempotency, and observability.
- `Docs-first delivery`: every feature must map to project requirement IDs before coding.

## Folder map

- `BA/`: scope, requirements, acceptance criteria, short build plan
- `Tech/`: service boundaries, Kafka topology, DB/cache, DDD+EDD playbook
- `Infra/`: local stack, observability, operations runbook
- `Interview/`: demo flow, incident playbooks, talking points

## Suggested reading order

1. `BA/01-project-scope.md`
2. `BA/02-requirements.md`
3. `BA/03-build-plan-few-days.md`
4. `BA/04-phase-roadmap.md`
5. `Tech/01-service-catalog.md`
6. `Tech/02-kafka-topology.md`
7. `Tech/03-data-db-cache.md`
8. `Tech/04-ddd-edd-playbook.md`
9. `Tech/05-database-design-and-operations.md`
10. `Tech/06-ddd-reference-architecture.md`
11. `Infra/01-local-stack.md`
12. `Infra/02-observability-runbook.md`
13. `Interview/01-interview-package.md`
