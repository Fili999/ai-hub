## Skills and agents hub (ai-hub)

The hub is at `{{HUB_ROOT}}` (its scripts are in `{{HUB_ROOT}}/scripts`).
For every non-trivial goal, start with the `orchestrator` skill: it finds the right skills and agents in the catalog on its own, checks tools and risks, then does the work. Do not wait for the user to name a skill or agent.
To install, assign, update or sync skills and agents (GitHub links included) use the `hub-manager` skill.
If a skill or agent needs a program that is missing, run `node "{{HUB_ROOT}}/scripts/needs.mjs" <names> --install`: it installs only if the user allowed it in the hub Settings; exit code 3 means it is not allowed and you must ask the user.
