# Taste
- Prefers unrelated work to land as its own standalone, topically-scoped commit rather than being folded into an in-progress commit. Confidence: 0.7
- Never wants a `Co-authored-by` trailer or any co-author line added to commit messages ("never ever"). Confidence: 0.9
- Prefers Conventional Commits style — a `type(scope): subject` header with a paragraph-length body explaining what was done and why. Confidence: 0.85
- Wants work to stop at each major phase/step so they can review the code before anything is committed — review checkpoints over continuous building. Confidence: 0.85
- Prefers durable project rules to live in a harness-agnostic `AGENTS.md` at the repo root rather than tool-specific config files, so any AI coding agent picks them up. Confidence: 0.7
- Prefers simple, flat file layouts over nested or self-referential structures. Confidence: 0.55
- Issues terse one-word commands ("resume", "yes", "done") and expects the agent to pick up from existing context and continue the work directly, without a recap, re-planning, or confirmation prompts. Confidence: 0.65
