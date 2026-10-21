# Architecture Decision Records

One file per decision that would be expensive to reverse. Filename: `NNNN-short-slug.md`.

Each record states:

- **Context** — what forced a choice
- **Decision** — what we chose
- **Consequences** — what it costs, and what it forecloses

ADRs are written as the corresponding code lands, not in advance. A record whose decision is
still unimplemented is marked **planned** and gets its content when the code arrives.

## Index

| ADR  | Decision                                                              | Status  |
| ---- | --------------------------------------------------------------------- | ------- |
| 0001 | The daemon owns the mIRC socket; agent connections are ephemeral       | planned |
| 0002 | NDJSON wire protocol ("MBP") and the mSL constraints that shape it     | planned |
| 0003 | MCP is the only agent surface — no REST door                          | planned |
| 0004 | Target MCP revision `2025-11-25`, structure for `2026-07-28`           | planned |
| 0005 | State-aware, idempotent compound commands                             | planned |
| 0006 | Shared bearer token, and default-deny gating for `raw`                 | planned |
| 0007 | Structured JSONL logging with mandatory redaction                     | planned |
| 0008 | `selfnick` is first-class state, not an edge case                     | planned |
| 0009 | Failure taxonomy and pre-flight checks                                | planned |
| 0010 | Relay DCC outcomes only; do not report progress                       | planned |
| 0011 | Topology and the filesystem boundary                                  | planned |
