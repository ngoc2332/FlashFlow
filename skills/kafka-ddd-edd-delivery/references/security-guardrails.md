# Security Guardrails for Agent

These rules are mandatory for all tasks in this project.

## 1) Secrets handling

- Never hardcode secrets (API keys, passwords, tokens, private keys).
- Never commit secrets to git history.
- Never print secrets in logs, terminal output, or PR notes.
- Use environment variables or approved secret stores only.

## 2) Data privacy

- Do not put sensitive PII into Kafka payloads unless required by business design.
- Prefer identifiers (`orderId`, `userId`) over direct personal data.
- Apply redaction/masking for logs containing email, phone, tokens, or credentials.

## 3) Command and environment safety

- Treat destructive commands as approval-gated.
- Do not run `rm -rf`, `git reset --hard`, `DROP/TRUNCATE`, or equivalent without explicit approval.
- Do not access production systems by default.
- Keep file operations scoped to the repository unless explicitly approved.

## 4) Network safety

- Use only trusted/approved domains relevant to the task.
- Do not execute untrusted remote scripts (for example `curl ... | sh`).
- Validate dependency source and integrity before introducing new packages.

## 5) Dependency and supply-chain hygiene

- Pin dependency versions.
- Keep lockfiles updated and committed.
- Run vulnerability checks for dependency updates when available.

## 6) Pre-merge security gate

Before finalizing changes:

- Confirm no secrets are present in modified files.
- Confirm logs and docs do not leak credentials or sensitive payloads.
- Confirm security checklist items in `feature-checklist.md` are satisfied.
