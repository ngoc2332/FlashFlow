# Hướng Dẫn Triển Khai Feature Theo DDD + EDD

Dùng playbook này cho mọi feature mới.

## Bước 1: Map requirement trước khi code

- Chọn requirement IDs từ `BA/02-yeu-cau.md`.
- Tối thiểu phải có: một `FR`, một `KR`, một `DER`, một `TR`.
- Ghi mapping này vào task notes hoặc PR description.
- Nếu feature đụng persistence, đọc `Tech/05-thiet-ke-va-van-hanh-database.md` trước.

## Bước 2: Chốt bounded context và aggregate

- Xác định bounded context bị tác động.
- Xác định aggregate root và invariants.
- Xác nhận ownership: một service chịu trách nhiệm transaction boundary của aggregate đó.

## Bước 3: Thiết kế event trước (EDD)

- Chốt event là domain event hay integration event.
- Định nghĩa event name, key (`orderId`), required headers, schema version.
- Xác định retryable hay non-retryable và hành vi DLQ.

## Bước 4: Thiết kế consistency và reliability

- Dùng outbox cho đường publish từ DB sang Kafka.
- Dùng dedup theo `eventId` để xử lý at-least-once.
- Dùng manual commit sau khi business processing thành công.

## Bước 5: Implement

- Giữ domain logic trong domain layer.
- Để Kafka, DB, Redis operations ở infrastructure adapters.
- Giữ handler mỏng, gọi domain service cho business rule cốt lõi.

## Service skeleton mặc định

Dùng layout này cho mọi runtime service:

```text
src/
  domain/
  application/
  infrastructure/
  interfaces/ (optional)
  server.ts | worker.ts | publisher.ts | updater.ts
```

Quy tắc:

- `domain` không được gọi trực tiếp DB/Kafka/HTTP.
- `application` sở hữu orchestration và transaction boundary.
- `infrastructure` sở hữu adapter và SQL/client calls.
- entrypoint phải mỏng (wiring + transport + metrics/logging).

## Bước 6: Validate

- Chạy unit tests cho aggregate invariants.
- Chạy integration tests cho produce/consume flows.
- Chạy failure tests cho retry/DLQ và restart recovery.

## Bước 7: Cập nhật docs và ghi chú phỏng vấn

- Cập nhật docs khi contract hoặc context boundary thay đổi.
- Ghi delivery note ngắn: requirement mapping, tradeoffs, risks.
