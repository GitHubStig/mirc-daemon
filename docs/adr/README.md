# Architecture Decision Records

One file per decision that would be expensive to reverse. Filename: `NNNN-short-slug.md`.

Each record states:

- **Context** — what forced a choice
- **Decision** — what we chose
- **Consequences** — what it costs, and what it forecloses

These record the decisions taken before the code was written, from the design discussion kept under
`docs/discussion/`. They describe intent, so where an ADR and the code disagree, one of them is
wrong — fix whichever it is in the same change.

## Index

| ADR  | Decision                                                         | Status   |
| ---- | ---------------------------------------------------------------- | -------- |
| 0001 | The daemon owns the mIRC socket; agent connections are ephemeral | accepted |
| 0002 | NDJSON wire protocol, shaped by mSL                              | accepted |
| 0003 | MCP is the only agent surface                                    | accepted |
| 0004 | Target MCP revision `2025-11-25`                                 | accepted |
| 0005 | State-aware, idempotent compound commands                        | accepted |
| 0006 | One shared bearer token, and default-deny gating                 | accepted |
| 0007 | Structured JSONL logging, with mandatory redaction               | accepted |
| 0008 | Our own nick changes are first-class state                       | accepted |
| 0009 | Failure taxonomy and pre-flight checks                           | accepted |
| 0010 | Relay DCC outcomes, not progress                                 | accepted |
| 0011 | Topology and the filesystem boundary                             | accepted |
