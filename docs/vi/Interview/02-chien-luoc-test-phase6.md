# Chiến Lược Test Phase 6

## Mục tiêu

Đảm bảo có test thực thi được cho:

1. Unit-level aggregate invariants
2. Integration flow produce/consume
3. Failure handling (retry/DLQ) và restart recovery

## Lệnh test

- Unit invariants:

```bash
make unit-phase6
```

- Full integration/failure/recovery smoke:

```bash
make smoke-phase6
```

## `smoke-phase6` kiểm tra gì

1. Boot thành công service + observability stack (`phase5` profile).
2. Unit tests cho common invariants pass.
3. Happy path: `order.created -> payment.succeeded -> inventory.reserved`.
4. Failure path: retry đúng tiến trình và vào DLQ khi terminal.
5. Recovery: restart worker xong vẫn hội tụ về trạng thái đúng.
6. Metrics và Prometheus scrape có dữ liệu sau khi bắn traffic.

## Mapping với roadmap Phase 6

- Unit tests aggregate invariants: `scripts/unit-phase6.sh`
- Integration tests flow: `scripts/smoke-phase6.sh` case 1
- Failure tests retry/DLQ + restart recovery: `scripts/smoke-phase6.sh` case 2 và case 3
