# Contributing to project-Pi

project-Pi is a development fork of PI-Desktop. Its focus is a project-oriented workspace for work that continues across conversations and agent sessions. Features are still evolving; reports grounded in actual usage and focused, reviewable improvements are especially useful.

## Before changing the code

Read [AGENTS.md](AGENTS.md), the relevant package instructions and the applicable [specifications](docs/spec/README.md). Preserve user data, permission boundaries and existing interfaces. For security-sensitive reports, follow [SECURITY.md](SECURITY.md), not a public issue.

The fork's published branch is `development`. The inherited `AGENTS.md` and delivery documents describe an upstream workflow based on `origin/main`; that branch can differ substantially from this fork's development candidate. Preserve the fork's changes when preparing work, and resolve any workflow conflict with the maintainer rather than resetting or silently replacing either history. Use a dedicated branch and worktree, and do not disturb another contributor's changes.

## Develop and validate

See the [README](README.md#run-from-source) for prerequisites and startup. Update the relevant documentation when behavior changes. Select checks for the affected surface; common commands include:

```bash
pnpm build:js
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
git diff --check
```

Document any required check that could not run and its effect. Never commit credentials, private user data, local databases, logs, dependencies or unrelated build output.

## Propose a change

Explain the problem, the approach, the affected behavior and the checks performed. Link relevant specifications and note compatibility or security implications. Use English for repository documentation, code and commit messages as required by `AGENTS.md`.

For a contribution intended for the original PI-Desktop project, consult its [current contribution policy](https://github.com/vastsa/PI-Desktop/blob/main/CONTRIBUTING.md) and prepare it against the upstream project separately. Upstream release procedures and acceptance restrictions do not by themselves establish policies or releases for this fork.
