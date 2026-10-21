# Taste

- Prefers exposing agent capabilities as MCP tools (typed tool calls) over long prose
  "skill.md"-style instruction documents, citing that lengthy instruction docs send local models
  into hallucination/infinite tool loops. Confidence: 0.6
- Anchors design reviews on the concrete end-to-end user story (the exact workflow they want to
  perform) and pushes back hard when the assistant scopes the wrong component; wants the goal
  restated correctly before code. Confidence: 0.55
- Writes terse, direct corrections ("that's not right") and expects the assistant to restate its
  understanding of the goal before proceeding. Confidence: 0.5
- Prefers simple, flat structures over nested/indirect ones — dislikes redundant depth (e.g. a child
  folder named the same as its parent) and will flatten or delete it to keep things simple and
  obvious. Confidence: 0.5
- Values AI-harness-agnostic repo setup: wants durable agent rules to live in the portable,
  widely-read `AGENTS.md` (rather than a vendor-specific location) so other harnesses like Cursor,
  Claude Code and Pi honor the same conventions. Confidence: 0.5
- Prefers a single source of truth for agent rules: once a rule is captured in the canonical file
  (e.g. `AGENTS.md`), wants the duplicate removed elsewhere (e.g. taste) rather than maintained in
  two places. Confidence: 0.55
- When the assistant can't perform an edit itself, wants it to say so plainly and name the exact
  line(s) to change so the user can do it manually — prefers that over a workaround or silent
  skipping. Confidence: 0.5
