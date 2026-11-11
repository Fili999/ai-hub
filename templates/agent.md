---
name: agent-name
description: What kind of work to delegate to this agent, in 1-3 sentences. Claude chooses it by reading this text, so describe concrete use cases.
tools: Read, Write, Edit, Glob, Grep, Bash   # remove what is not needed: an agent with fewer tools is safer
model: sonnet                                # optional
skills: []                                   # skills specific to this agent (others can be linked with: npm run link -- add agent:<name> skill:<skill>)
capabilities: []                             # optional: general capabilities, in kebab-case
categories: [video]                          # optional
---

You are the specialist in … Your task is …

## How you work

1. …
2. …

## Limits

- Do not publish, send, or delete anything without explicit confirmation.
