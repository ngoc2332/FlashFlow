# Phase 6 Test Strategy

## Goal

Provide executable coverage for:

1. Unit-level aggregate invariants
2. Integration produce/consume flow
3. Failure handling (retry/DLQ) and restart recovery

## Test commands

- Unit invariants:

```bash
make unit-phase6
```

- Full integration/failure/recovery smoke:

```bash
make smoke-phase6
```

## What `smoke-phase6` validates

1. Services + observability stack boot successfully (`phase5` profile).
2. Unit tests for common invariants pass.
3. Happy path: `order.created -> payment.succeeded -> inventory.reserved`.
4. Failure path: retry progression and terminal DLQ routing.
5. Recovery: worker restart still converges to expected order status.
6. Metrics and Prometheus scrape are available after traffic.

## Mapping to Phase 6 roadmap

- Unit tests for aggregate invariants: `scripts/unit-phase6.sh`
- Integration tests for flows: `scripts/smoke-phase6.sh` case 1
- Failure tests for retry/DLQ + restart recovery: `scripts/smoke-phase6.sh` case 2 and case 3
