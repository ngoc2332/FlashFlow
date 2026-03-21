# Feature Delivery Checklist (DDD + EDD)

Use this checklist before opening PR.

## Docs and requirement traceability

- [ ] Requirement mapping includes at least: 1 `FR`, 1 `KR`, 1 `DER`, 1 `TR`
- [ ] Task notes or PR description includes requirement IDs
- [ ] Docs updated if contracts/boundaries changed

## DDD design

- [ ] Bounded context identified
- [ ] Aggregate root identified
- [ ] Aggregate invariants stated
- [ ] Transaction boundary stays within one aggregate

## EDD design

- [ ] Event type classified (`domain` or `integration`)
- [ ] Topic, key, headers, schema version defined
- [ ] Backward compatibility considered
- [ ] Retry/DLQ behavior defined

## Reliability and data consistency

- [ ] Outbox path used where DB + event publish are coupled
- [ ] Consumer dedup by `eventId` implemented
- [ ] Offset commit after successful processing
- [ ] Failure path tested (retry -> DLQ)
- [ ] DB constraints and indexes match `Tech/05-*` guidance
- [ ] Migration plan includes rollback note

## Security and privacy

- [ ] No secrets hardcoded in code, docs, scripts, or configs
- [ ] No secrets or sensitive values printed in logs/output
- [ ] Network calls stay within approved scope for the task
- [ ] Destructive commands are approval-gated
- [ ] Event payloads/logs avoid PII leakage and include redaction where needed
- [ ] Dependency changes are pinned and reviewed for risk

## Testing

- [ ] Unit test for domain invariant(s)
- [ ] Integration test for produce/consume flow
- [ ] Restart/failure recovery test
