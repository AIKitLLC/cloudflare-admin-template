# Agents

This repository is a Payload CMS v3 and Next.js admin template on Cloudflare Workers (OpenNext, D1, R2). `AGENTS.md` is the source of truth for how agents work here. The always-apply rules in `.cursor/rules/` repeat the limits and point back here.

## Skills to load

Load both vendored skills at the start of a task. Do not rewrite them in place. To update one, replace the directory from a new upstream commit and keep the attribution header, the commit SHA, and the MIT `LICENSE`.

| Skill | Path | Upstream | Commit | License |
| --- | --- | --- | --- | --- |
| ponytail | `.agents/skills/ponytail/SKILL.md` | https://github.com/DietrichGebert/ponytail | `9b58c1ffb790c075ca32e70a89cf1d80588f4abf` | MIT, Copyright (c) 2026 DietrichGebert |
| ponytail Cursor rule | `.agents/skills/ponytail/ponytail.mdc` | same repo, `.cursor/rules/ponytail.mdc` | same commit | same |
| i-have-adhd | `.agents/skills/i-have-adhd/SKILL.md` | https://github.com/ayghri/i-have-adhd | `723af7d9afaf43eb871dbcce6129e2bf80de90d5` | MIT, Copyright (c) 2026 Ayoub Ghriss |

Ponytail level is `full` unless the user asks for `lite` or `ultra`. The smallest complete change wins. Reuse the code and the platform feature that already exist. Do not add a dependency for a few lines. Do not add an abstraction, wrapper, or config nobody asked for.

i-have-adhd is always on for agents in this repo, including Cursor cloud agents, via `.cursor/rules/output-style.mdc`. The upstream skill file sets `disable-model-invocation: true`; that flag does not turn the project rule off. Lead with the next action, number multi-step work, cap a chat list at 5 items, and skip the preamble and the recap. The ponytail risk line at the end of a code change is required. It is not a closing pleasantry.

The upstream always-on snippet is the one in `INSTALL.md` of i-have-adhd ("Cursor, Amp, and any other agent-skills harness"). The project rule is that snippet.

## Cloudflare skills

Consult these when designing or changing Workers, D1, R2, OpenNext, or Wrangler config. They live in https://github.com/cloudflare/skills at commit `0871daceb347e3c51693fbe9c77555468df7e410`. Do not vendor them.

| Skill | Use it for |
| --- | --- |
| `skills/wrangler` | Wrangler config, types, and commands. Use the repo's Wrangler (`~4.116.0` in `package.json`). |
| `skills/workers-best-practices` | Runtime, bindings, secrets, logs, and traces. |
| `skills/durable-objects` | Only a change that adds Durable Objects. This repo has none. |
| `skills/web-perf` | Loading and interaction performance. |
| `skills/nextjs-on-cloudflare` | Next.js on Workers. This repo uses OpenNext (`@opennextjs/cloudflare`), not vinext. |

Prefer the skill and the current Cloudflare docs over memory. `wrangler.jsonc` does not set `observability.enabled`. Leave that alone unless the task is observability.

## Architecture

Decouple at real boundaries: domain modules, adapters for external services, and platform bindings. No speculative abstractions or single-implementation interfaces.

A boundary is real when it is one of those three, or when a second caller already exists. A single function with one caller stays a function. Modules talk through explicit public entry points. No deep imports across modules. `src/payload.config.ts` is the composition root: it is the only place that wires collections to D1 and R2.

The current map and the target boundaries are in `docs/ARCHITECTURE.md`. Ponytail and this rule agree: do not invent a module for a feature that has no code yet.

## Workflow

1. Every change has a GitHub issue before the code. Search open issues first and do not file a duplicate.
2. The pull request body contains `Closes #N`.
3. Update `docs/STATUS.md` in the same pull request. The date at the top changes with the snapshot.
4. Do not merge without Tony's approval. A draft pull request is the default.
5. Do not deploy. Do not run `wrangler login`, `wrangler secret put`, `wrangler d1`, `wrangler r2`, or any other command against a Cloudflare account. Do not read, write, or invent secrets. Do not add a paid service, including a Workers paid plan.
6. Do not edit files owned by open pull requests #11, #12, #13, #14, or #15. Add new files when a change would collide with them.

`docs/STATUS.md` records the planned merge order and the deploy prerequisites those pull requests named. Recording them is not permission to run them.

## arcade-agent before a large refactor

Use the local MCP server before a change that moves a public entry point or touches more than one module. The server is `arcade-mcp` from PyPI `arcade-agent` `0.4.1` (https://github.com/arcade-agent/arcade-agent, docs https://arcade-agent.dev/docs/getting-started/). `.cursor/mcp.json` starts it with:

```bash
uvx --exclude-newer 2026-10-16T00:00:00Z --from "arcade-agent[mcp,languages]==0.4.1" arcade-mcp
```

The `[languages]` extra supplies the TypeScript parser. `uv` has to be installed on the machine that runs Cursor. Do not add that install to GitHub Actions. The workflow below installs the pinned package itself.

1. Call `analyze` with `source` set to the repository root and `language` set to `typescript`. Keep `graph.session_id` and `architecture.session_id`.
2. Call `context_for_task` with that graph session id and a one-sentence task. Read the files it returns before editing.
3. Call `diff_impact` with the graph session id, the paths you expect to change, and the architecture session id.

`analyze` stores those session ids as each stage finishes. Pass the session id, not the full graph. Parse cache files under `.arcade-cache/` are local. Do not commit them.

## Architecture CI

TypeScript is a supported arcade-agent language (Java, Python, C, TypeScript/JS, Go, Kotlin, Rust). `.github/workflows/architecture.yml` runs arcade-agent as an inline job on `pull_request`: `actions/checkout` and `actions/setup-python` pinned to release-tag commits, `persist-credentials: false`, and `pip install --require-hashes` from `.github/arcade-agent/requirements.txt` (`arcade-agent[languages]==0.4.1` and its dependencies, regenerated from `requirements.in` with the command in that file). `--exclude-newer` in `.cursor/mcp.json` keeps the local `uvx` resolution to packages published before that date.

The job is report-only: `continue-on-error: true`, runner `ubuntu-24.04`, and read-only `contents` permission. It posts no comment and uploads no artifacts, so it does not need a write token. The report is the Actions log. A failed analysis does not block the pull request.
