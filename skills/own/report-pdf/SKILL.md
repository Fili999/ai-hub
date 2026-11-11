---
name: report-pdf
description: Generate a comprehensive, detailed, and elegant PDF report reconstructing the entire project journey from concept through development, architecture, challenges and solutions, organized into chapters, milestones, and key highlights. Styled with brand assets (colors, Space Grotesk or Montserrat fonts, logo, slogan) and strategic typographic highlights.
capabilities: [report-pdf, documentation, pdf-generation]
categories: [data, research, design, dev-app, project-mgmt]
requires-commands: []
---

# Report PDF

Generates a publication-quality PDF document that reconstructs the complete project trajectory: the genesis of the original concept, motivation and the "why", technical architecture, development phases, chronological milestones, encountered challenges and their solutions, up to the future roadmap. Integrates visual brand assets (logo, slogan, color palette from `brand/brand-kit.json`) and respects typographic design choices (Space Grotesk, Montserrat, or custom).

## When to use

- When the user asks for a comprehensive, executive, or technical project report in PDF format.
- To document and showcase historical evolution: from initial concept to solved challenges and architectural decisions (ADR/Decision Records).
- To present a clear overview structured into chapters, milestones, and key takeaways for clients, stakeholders, investors, or the team.
- When a polished layout is required, branded with project logo, colors, and modern typography (Space Grotesk, Montserrat).

## When not to use

- For short answers, quick notes, or simple inline markdown in chat.
- To exclusively create presentation slides (use presentation or slide skills instead).
- To extract isolated technical diagrams without narrative context (use `archify` or similar).

## Procedure

1. **Historical Reconstruction & Project Analysis**:
   - Inspect the entire repository: configuration files (`package.json`, `hub.config.json`, README), `docs/`, `memory/`, decision records (`decision-record`), and Git history (`git log --reverse --oneline` or thematic logs).
   - Extract the 5 narrative pillars:
     1. *The Idea & Vision*: the problem being solved, the context, the "why".
     2. *Architecture & Technical Choices*: stack, contracts, models, and dependencies.
     3. *Milestones & Development*: chronological timeline and intermediate goals achieved.
     4. *Challenges & Solutions*: technical hurdles, complex bugs, trade-offs, and how they were overcome.
     5. *Current State & Roadmap*: project status today and immediate next steps.
   - For detailed analysis guidance, see [Reconstruction Guide](references/reconstruction-guide.md).

2. **Asset Discovery & Brand Selection**:
   - Check for brand kit in `brand/brand-kit.json`, `brand/`, `ui/public/brand/`, or repository assets.
   - Retrieve:
     - **Logo**: file path (SVG or PNG) or project mark.
     - **Slogan / Tagline**: identity statement of the project.
     - **Color Palette**: Primary, secondary, background, accent, and text colors.
     - **Typography**: Space Grotesk (modern tech, punchy geometric), Montserrat (elegant, versatile, clean), or project default (Inter, Plus Jakarta Sans).
   - For pairing details, see [Typography and Brand Guide](references/typography-and-brand.md).

3. **Content Drafting with Editorial Hierarchy**:
   - Organize the report into clearly numbered sections:
     - **Cover Page**: Logo, Project Title, Tagline, Version, Author/Team, Release Date.
     - **Table of Contents**: Navigable chapters and subchapters.
     - **Executive Summary & Key Highlights**: Highlight cards with **bold** for core concepts and *italics* for reflections and quotes.
     - **Chapters 1–5**: In-depth analysis with callout boxes for *Problem Encountered* (red/amber) and *Solution Implemented* (green/blue).
     - **Milestone Timeline**: Visual grid or table with dates, status (Completed, In Progress, Planned), and impact.

4. **HTML Composition (Dual-Mode Screen & Print Architecture)**:
   - Use the template in [Report Template](templates/report-template.html) or include the essential CSS block:
     ```css
     /* Print and PDF (A4 native with margins) */
     @page { size: A4 portrait; margin: 20mm 18mm 20mm 18mm; @bottom-right { content: "Page " counter(page); } }
     @page:first { margin: 0; @bottom-right { content: none; } }

     /* Screen and Browser preview (centered reader sheets, never edge-stuck) */
     @media screen {
       body { background-color: #0b132b; padding: 40px 20px; min-height: 100vh; }
       .cover-page, .chapter { max-width: 880px; margin: 0 auto 36px auto; border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,0.35); overflow: hidden; }
       .cover-page { height: auto; min-height: 860px; padding: 55px 48px; }
       .chapter { background: #ffffff; padding: 50px 48px; border: 1px solid var(--border-color); }
       .arch-diagram-card, .milestone-table { overflow-x: auto; }
     }
     ```
   - Save the HTML file in the designated destination (e.g. `reports/<slug>-report.html` or user-specified path).

5. **PDF Compilation via Skill Script**:
   - Always run the skill's cross-platform Node.js script:
     ```bash
     node "<hub>/skills/own/report-pdf/scripts/generate-pdf.mjs" "<path_to_file.html>" "<path_to_file.pdf>"
     ```
   - *Guarantee*: `generate-pdf.mjs` automatically inspects the HTML file and injects the `@media screen` block if missing before compiling to PDF.
   - Verify that the generated PDF file exists, is readable, and has a non-zero file size.

## Expected output

```
PDF report generated successfully!
- PDF file: <path/to/report.pdf> (<size>)
- HTML source: <path/to/report.html>
- Typography: Titles <Font>, Body <Font>
- Brand assets included: Logo, Color palette, Slogan
- Content: <N> chapters, <M> milestones, <K> challenges & solutions documented
```

## Warnings

- **Mandatory Dual-Mode Screen / PDF rendering**: HTML must never render edge-to-edge in a browser window. Always include the `@media screen` block with maximum width and centered margins (`max-width: 880px; margin: 0 auto;`), leaving `@page` rules intact for PDF rendering.
- **Source fidelity**: Do not fabricate decisions, issues, or dates not grounded in real commits or documentation. Flag uncertainties clearly.
- **Page break controls**: Ensure long tables and milestone blocks avoid splitting across pages via `page-break-inside: avoid`.
