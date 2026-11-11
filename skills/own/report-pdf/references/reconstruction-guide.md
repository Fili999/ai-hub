# Project Trajectory Reconstruction Guide

This guide describes the systematic process by which the `report-pdf` skill investigates a project from beginning to end to extract its historical narrative, motivations, architectural choices, and sequence of challenges and solutions.

---

## 1. Exploratory Phase: From Genesis to Current Context

To understand the full lifecycle of a project, reviewing the final state of the files is not enough: its evolution over time must be examined.

### Key Tools & Commands:

1. **Git History (The chronological timeline)**:
   - `git log --reverse --oneline`: reveals the initial commit (the "embryonic idea"), pivots, and major checkpoints.
   - `git log --grep="feat" --grep="fix" --grep="refactor"`: groups milestones by category.
   - `git tag -l -n`: identifies formal release points and stable versions.

2. **Vision Documents & Specifications**:
   - `README.md`, `CONTRIBUTING.md`, `docs/`: provide the stated goals and architecture.
   - `memory/`, `evaluations/`, `docs/decisions.md`, ADR files (*Architectural Decision Records*): contain the trade-offs and rationale ("why we chose approach A over approach B").

3. **Configurations & Dependencies**:
   - `package.json`, `hub.config.json`, `pyproject.toml`, `Cargo.toml`: show dependencies introduced, upgraded, or removed.

---

## 2. The Five Narrative Pillars

In the report, each pillar should be thoroughly developed:

### A. The Idea & "The Why" (Genesis & Vision)
- **What was the initial problem?** (e.g. tool fragmentation, lack of automation, workflow latency).
- **Who is the target audience?**
- **What was the core thesis or unique value proposition?**
- *Typographic styling*: use **bold** for the core value proposition and *italics* for motivational reflections.

### B. Architecture & Technical Choices
- **Architectural pattern**: modular monolith, event-driven, plugin/skill-based, client-server.
- **Tech stack selection**: why Node.js, Python, TypeScript, or specific frameworks were chosen, and what constraints existed.
- **Contracts & integrations**: APIs, JSON schemas, safety boundaries.

### C. Development Journey & Milestones
- Break the journey into **distinct phases** (e.g. PoC Prototype, Core Architecture, Tool Integration, Optimization & Hardening, Release v1.0).
- Assign to each milestone:
  - **Date or estimated period**.
  - **Primary objective achieved**.
  - **Key deliverables produced**.
  - **Status**: *Completed*, *In progress*, *Planned*.

### D. Challenges, Roadblocks & Solutions
This chapter provides critical technical credibility:
1. **Problem description**: symptoms, impact on performance or stability, failure modes.
2. **Root cause**: what triggered the bug or limitation (e.g. async concurrency, Windows vs POSIX path discrepancies, license constraints).
3. **Implemented solution**: structural change or fix applied.
4. **Trade-offs & rationale**: why this fix was selected over alternatives.

### E. Current State & Future Roadmap
- Completed and tested capabilities.
- Test suite outcomes and quality metrics (`npm test`, benchmarks).
- Immediate and medium-term priorities.

---

## 3. Narrative Quality Checklist

Before compiling the HTML and PDF:
- [ ] No dates, metrics, or bugs fabricated.
- [ ] Documented issues reflect real events in code or commit history.
- [ ] Technical vocabulary is consistent throughout.
- [ ] Key takeaways are scannable via balanced use of **bold**.
