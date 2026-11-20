---
name: extension-upgrade-review
description: Read-only review of a Chrome/Chromium (Manifest V3) browser-extension codebase for upgrade safety, meaning what breaks for users when a new version auto-updates over an old one. It covers content scripts left orphaned in open tabs, re-injection, double-running listeners, MAIN/ISOLATED world handoff, background↔content messaging across service-worker restarts, storage migrations and rollbacks, context menus/alarms/DNR rules that persist across updates, permission increases that disable the extension, and upgrade tests. Use it whenever someone wants an extension project reviewed, audited or checked before a release, asks "will this break when users update?", "is my extension update-safe?", or "why do users need to reload tabs after an update?", or wants a release-readiness check of a WXT/Plasmo/CRXJS/vanilla extension, even if they don't say "upgrade". Reports findings with file:line evidence and suggested fixes; it does not edit code.
---

# Extension upgrade-safety review

You're reviewing a browser-extension codebase for one question: **when users auto-update from
the previous version to this one, what breaks?** You produce a review report, and you don't change
the project. Fixes are suggestions in the report; apply them only if the user asks afterwards, as
a separate step.

Why this matters: an update unloads every extension context and loads the new version. The service
worker restarts and extension pages close. Content scripts in open tabs keep running but are cut
off from the extension, and the new version isn't injected into those tabs. Only a few things
cross from old to new: stored data, persistent registrations, the DOM of open pages, and anything
outside the extension (pages, native hosts, the backend). Almost every upgrade bug lives on one of
those seams, and none of them show up in ordinary testing, because a fresh install is a different
code path from an update.

## Inputs

- The project root: the current directory unless the user names one. In a monorepo with several
  extensions, review the one the user means. If that's unclear, list the manifests you found and
  ask.
- Optionally a baseline: the last released tag, commit or version to compare against. If git
  history exists and the user didn't name one, find the latest release tag yourself (step 3).

## Workflow

### 1. Inventory: run the scanner first

```bash
node <skill-dir>/scripts/scan.mjs <project-root>
```

It's read-only and dependency-free. It finds:
- source and built manifests, and the build tooling (WXT, Plasmo, CRXJS)
- the **entry points**, and the files **reachable** from them
- `file:line` hits for every API the checklist cares about, split into live code and the rest
- top-level declarations in content-script entries, module-level state in the worker, and
  upgrade-related tests

`--json` gives the same data structured; `--all` also lists hits in unreachable files.

If no entry points resolve (generated manifest, unusual layout), find them from the build config
(`wxt.config.*`, `vite.config.*`, `webpack.config.*`, `package.json` scripts) and work from there.
A built manifest under `dist/`, `build/` or `.output/` shows the real shape; the scanner reads
those manifests even though it skips build directories for source code.

### 2. Scope to live code

Real projects are large and carry dead code: old entry points, abandoned experiments, copies of
vendored libraries. Findings in code that never runs are noise and cost the reader's trust. So:

- Review **from the entry points outward**: background/service worker, each content-script entry,
  and extension pages, following imports only as far as the lifecycle, messaging, storage or
  registration code goes.
- Use the scanner's live hits to jump straight to the relevant lines. Don't read every file.
- Ignore code the scanner lists as not reachable, unless something live turns out to load it
  dynamically (computed paths, `executeScript` with a variable `files`, a bundler alias the scan
  couldn't resolve). If a pattern appears **only** in unreachable code, say so in one line; don't
  report it as a finding.
- Tests, build scripts and tooling are not extension code. They count only for G2 (are upgrades
  tested).
- Bundled, minified or generated code (`dist/`, vendor files): review the source that produces it.
  Look at build output only to answer a specific question (e.g. "is the content script emitted as
  an IIFE?").

### 3. Compare with the last release, if there's history

Several rules only make sense as a diff:
- new permissions with a warning (E2)
- removed or renamed `web_accessible_resources` (E3)
- a changed storage shape without a migration (C1)
- renamed content-script namespaces or protocols (A3, F1)

```bash
git tag --sort=-creatordate | head -5    # pick the last release; or ask
git diff <tag> -- '**/manifest.json' <manifest-generating config>
git diff --stat <tag> -- <live source dirs>
```

Read-only git commands only. No history? Say which checks that leaves unverified.

### 4. Apply the checklist

Read `references/checklist.md`: rules A–G, each with why, how to check, what passes, and default
severity. Go section by section, and skip a section whose surface doesn't exist (no content
scripts → A is N/A). For each applicable rule, decide one of:
- **Pass**
- **Partial**
- **Fail**
- **Unknown**: needs runtime behaviour, history or backend code you can't see. Say what would settle it.

Evidence standards, because a review is only as useful as it is trustworthy:
- Every Fail or Partial cites `file:line` from code you actually read. The scanner's hit line
  alone is a lead, not proof.
- Describe the concrete failure: "user updates while a tab is open → the click handler runs twice
  → the item is added twice". Not just "violates A3".
- Distinguish verified platform behaviour (✓ in the checklist) from general knowledge (○). Don't
  overstate the ○ ones.
- Credit equivalent designs. The checklist describes outcomes, not one mandated implementation. A
  project that solves A3 differently, for example by never keeping state in content scripts and
  re-rendering from storage, passes.
- If something can't be determined statically, mark it Unknown instead of guessing.

### 5. Write the report

Reply in the conversation with the report below. Write it to a file only if the user asks; a
review tool shouldn't leave files in their tree. Keep it scannable: the reader wants to know what
to fix first.

```markdown
# Upgrade-safety review: <project> (<version>, compared with <baseline or "no baseline">)

**Verdict:** <one or two sentences: is an update from the last release safe for users, and the top risk>

**Scope:** entry points <list>; reviewed <N> live files of <M> sources; skipped <K> unreachable
files (<one-line examples>); tooling <…>.

| Area | Status | Notes |
|---|---|---|
| A. Content scripts in open tabs | Fail / Partial / Pass / N/A | <short> |
| B. Messaging | … | … |
| C. Stored data | … | … |
| D. Persistent registrations | … | … |
| E. Applying updates and releases | … | … |
| F. Cross-version surfaces | … | … |
| G. Observability and tests | … | … |

## Findings (most severe first)

### [High] A3: content scripts run twice after an update
- **Evidence:** `src/content/index.ts:12`: listener added at top level, no teardown; `src/background.ts:40` re-injects on `onInstalled`.
- **What happens:** <concrete user-visible scenario>
- **Fix:** <adapted snippet or steps>; see the skill's fix patterns, "A3–A4, A7".

### [Medium] …

## Unknown / needs a runtime check
- <rule>: <why it can't be settled statically>, <the test that would settle it>

## Passed / not applicable
- <one line each, grouped>
```

Fix suggestions: read `references/fix-patterns.md` when you write them. Adapt the snippet to the
project's language, framework and style. Tested reference implementations are in `assets/`
(`reinject.js`, `sw-reinject.js`, `cs-lifecycle.js`); mention them when a project needs the whole
mechanism, and don't paste them in full.

### 6. Offer next steps

End with at most three concrete next steps: the top fix, the most valuable missing test, and the
release-specific risk if there is one. Offer to apply fixes or write the upgrade test, and wait
to be asked.

## Things to keep in mind

- **Firefox/Safari:** the checklist is Chromium MV3. Much of it carries over in spirit, but
  orphaning, world and update behaviour differ, so mark Chromium-specific conclusions as such
  when the project targets other browsers too.
- **MV2 projects:** background pages are persistent, and content-script orphaning still applies.
  Note that MV2 is unsupported in Chrome, and review against what applies.
- **Don't run builds, installs or tests** unless the user agrees. They change the working tree or
  take a long time. The scanner and read-only git commands are enough for a static review.
