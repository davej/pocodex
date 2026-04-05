---
name: commit
description: Use when asked to prepare, review, or create a git commit for this repository. Follow the local commit policy, keep commits scoped to the intended changes, run the fast required checks, and write Conventional Commits that work with release-please.
---

# Commit

## Overview

Use this skill when a user asks for a commit or asks how a commit should be written for Pocodex. The goal is to produce a clean, policy-compliant git commit that matches the actual diff and works with `release-please`.

## Workflow

1. Inspect the worktree with `git status --short` and `git diff --stat`, then read the diff for the files that are actually part of the requested change.
2. Exclude unrelated user changes. Do not stage or commit files outside the requested scope.
3. Run `pnpm run check:commit` before committing. If it fails, fix the issues or report the blocker instead of committing a broken tree.
4. Stage only the intended files with `git add <path>...`.
5. Write a Conventional Commit message that accurately describes the staged diff.
6. Commit with `git commit`. Prefer a single `-m` subject for small changes, or add a body when the why matters.

## Commit Rules

- Use Conventional Commits because `release-please` derives release notes and version bumps from merged commit history.
- Preferred types in this repo: `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`.
- Use an optional scope when it improves clarity, for example `feat(server): ...` or `fix(bootstrap): ...`.
- Use the imperative mood in the subject line.
- Keep the subject specific to the staged diff. Do not write broad summaries that cover unstaged work.
- Mark breaking changes with `!` in the header and include a `BREAKING CHANGE:` footer in the body.
- Avoid placeholder types such as `update`, `misc`, or `changes`.

## Message Shape

Use this shape:

```text
type(scope): short summary

Optional explanatory body.

BREAKING CHANGE: required when behavior or API compatibility changes.
```

## Choosing The Type

- `feat`: user-visible behavior or capability added
- `fix`: bug fix or regression fix
- `refactor`: internal restructuring without intended behavior change
- `docs`: README, CONTRIBUTING, skills, or other documentation-only changes
- `test`: test-only changes
- `build`: packaging, dependencies, or build tooling
- `ci`: GitHub Actions or other automation pipeline changes
- `chore`: maintenance that does not fit the above and should not usually trigger a release note highlight

## Examples

- `feat: add LAN URL fallback for remote browser sessions`
- `fix(server): ignore malformed ipc payloads`
- `build: add release-please automation`
- `docs(commit): document conventional commit policy`
- `refactor(app-server-bridge): inline typed event overloads`

## Guardrails

- Do not commit unrelated local edits just because they are present in the worktree.
- Do not bypass the `commit-msg` or `pre-commit` hooks unless the user explicitly asks.
- If the diff contains multiple unrelated concerns, split them into separate commits instead of forcing one message to cover everything.
- If you are unsure whether a change is release-relevant, still use the most accurate Conventional Commit type. `release-please` can decide whether it should cut a release.

## Command Pattern

For a normal commit flow in this repo:

```bash
git status --short
git diff --stat
pnpm run check:commit
git add <intended files>
git commit -m "type(scope): summary"
```

Run `pnpm run check` separately when you want the full validation pass, including tests. Add a second `-m` body when the rationale, migration notes, or breaking-change context matters.
