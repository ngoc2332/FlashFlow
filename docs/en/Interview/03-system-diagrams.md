# System Diagrams

## Bounded context and service map

```mermaid
flowchart LR
  OA[order-api]\n(Order BC)
  OB[outbox-publisher]
  PW[payment-worker]\n(Payment BC)
  IW[inventory-worker]\n(Inventory BC)
  SU[order-status-updater]\n(Read Model BC)
  OQ[order-query-api]

  T1[(order.created)]
  T2[(payment.events)]
  T3[(inventory.events)]
  TS[(order.status compacted)]
  TR5[(order.retry.5s)]
  TR1[(order.retry.1m)]
  DLQ[(order.dlq)]

  OA --> OB --> T1
  T1 --> PW --> T2
  T2 --> IW --> T3
  T1 --> SU
  T2 --> SU
  T3 --> SU --> TS --> OQ

  PW -.retry/dlq.-> TR5
  PW -.retry/dlq.-> TR1
  PW -.terminal.-> DLQ
  IW -.retry/dlq.-> TR5
  IW -.retry/dlq.-> TR1
  IW -.terminal.-> DLQ
  SU -.retry/dlq.-> TR5
  SU -.retry/dlq.-> TR1
  SU -.terminal.-> DLQ
```

## Happy path sequence

```mermaid
sequenceDiagram
  participant C as Client
  participant OA as order-api
  participant OB as outbox-publisher
  participant PW as payment-worker
  participant IW as inventory-worker
  participant SU as order-status-updater
  participant OQ as order-query-api

  C->>OA: POST /orders
  OA-->>C: 201 + orderId + traceId
  OA->>OB: outbox row
  OB->>PW: publish order.created
  PW->>IW: publish payment.succeeded
  IW->>SU: publish inventory.reserved
  SU->>SU: upsert order_status_view
  C->>OQ: GET /orders/:id/status
  OQ-->>C: INVENTORY_RESERVED
```

## Failure and recovery sequence

```mermaid
sequenceDiagram
  participant PW as payment-worker
  participant IW as inventory-worker
  participant R5 as order.retry.5s
  participant R1 as order.retry.1m
  participant D as order.dlq

  IW->>R5: retryCount=1
  R5->>IW: redelivery
  IW->>R1: retryCount=2
  R1->>IW: redelivery
  IW->>D: terminal failure

  Note over PW,IW: If worker restarts, manual commit + dedup keeps consistency
```
