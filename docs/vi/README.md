# Bộ Tài Liệu Dự Án Kafka (Tiếng Việt)

Dự án: **Nền tảng sự kiện thương mại điện tử realtime (Flash Sale)**

Bộ tài liệu này tối ưu cho:
- học nhanh Kafka core và nâng cao trong vài ngày
- dựng hệ thống local gần với production để vibe coding
- chuẩn bị câu chuyện phỏng vấn cho big tech / remote roles

## Cách tiếp cận kiến trúc

- `DDD`: mô hình hóa bounded context, aggregate, invariant và ubiquitous language.
- `EDD`: điều phối luồng liên dịch vụ bằng event và contract rõ ràng.
- `Độ tin cậy`: bắt buộc outbox, retries, DLQ, idempotency, observability.
- `Docs-first delivery`: mọi tính năng phải map requirement IDs trước khi code.

## Cấu trúc thư mục

- `BA/`: phạm vi bài toán, requirement, acceptance criteria, kế hoạch ngắn
- `Tech/`: ranh giới service, Kafka topology, DB/cache, playbook DDD+EDD
- `Infra/`: local stack, observability, vận hành runbook
- `Interview/`: luồng demo, incident playbook, talking points

## Thứ tự đọc để implement nhanh

1. `BA/01-pham-vi-du-an.md`
2. `BA/02-yeu-cau.md`
3. `BA/03-ke-hoach-xay-dung-vai-ngay.md`
4. `BA/04-lo-trinh-theo-phase.md`
5. `Tech/01-danh-muc-dich-vu.md`
6. `Tech/02-thiet-ke-kafka-topology.md`
7. `Tech/03-thiet-ke-du-lieu-db-cache.md`
8. `Tech/04-huong-dan-ddd-edd.md`
9. `Tech/05-thiet-ke-va-van-hanh-database.md`
10. `Infra/01-ha-tang-local.md`
11. `Infra/02-observability-va-runbook.md`
12. `Interview/01-goi-noi-dung-phong-van.md`
