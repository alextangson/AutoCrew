# Feature-Triage Skill Design

## Summary

A decision-making skill that evaluates whether a proposed feature belongs in AutoCrew and in what form. Uses four analytical frameworks (Socratic questioning, first-principles thinking, Occam's razor, Maslow's hierarchy) in a structured dialogue to produce a stored decision record.

## Design Decisions

- **Trigger**: Explicit only — user says "我想加 XX" / "能不能做一个" etc.
- **Output**: Structured decision report saved to `docs/decisions/YYYY-MM-DD-{slug}.md`
- **Terminal state**: Pure decision (做/不做/改形式再做). Does not chain into implementation.
- **Framework visibility**: Explicit — each framework labeled with emoji in conversation.
- **Challenge intensity**: Adaptive — light for small features, full scrutiny for architectural changes.

## Discussion Flow

### Complexity Assessment (silent, before Phase 1)

Signals:
- Introduces new external dependency/API?
- Changes existing data flow or pipeline stages?
- Affects 3+ existing skills/tools?
- Estimated 500+ lines of code?

0-1 yes → lightweight (merge frameworks, 2-3 rounds)
2 yes → medium (per-framework, 3-4 rounds)
3-4 yes → heavy (fully expanded, 4-6 rounds)

### Phase 1 — Socratic Questioning (understand essence)

Strip away surface requests, find the real problem. 1 question per round, until "what fundamental problem does this solve?" is clearly answered.

### Phase 2 — First Principles (decompose real vs false needs)

Break the idea into irreducible capability units. For each: does AutoCrew need to build this, or do existing tools/pipeline already cover it? Identify "borrowing bias" — wanting something because someone else has it.

### Phase 3 — Occam's Razor (cut complexity)

Find the simplest viable form. Can existing tools/skills be composed instead of building new? Cut all "might need later" parts. Propose: new skill / new tool action / extend existing / don't build.

### Phase 4 — Maslow's Hierarchy (position value)

Map to creator need levels:
- Survival: can publish, avoid violations
- Efficiency: faster output, less repetition
- Quality: better content, competitive edge
- Growth: followers, monetization, moats
- Self-actualization: unique methodology, industry leadership

Does this feature fill a current-level gap or skip levels?

## Prompt Engineering Techniques

1. **Chain-of-thought externalization**: Premise → Derivation → Conclusion structure, assumptions explicitly tagged.
2. **Few-shot decision examples**: One "build" and one "don't build" example embedded in skill.
3. **Persona + cognitive boundaries**: Product architect with explicit knowledge of AutoCrew's 18 tools, pipeline, and creator workflows.
4. **Red team self-check**: Before final conclusion, argue the opposite side with 3 points and attempt to refute each.
5. **Adaptive meta-prompt**: Complexity auto-detected from 4 signals, displayed to user with estimated rounds.

## Report Format

See SKILL.md for the full template. Key sections: conclusion, original proposal, per-framework analysis, implementation suggestion (if "build"), metadata.

## Date

2026-04-06
