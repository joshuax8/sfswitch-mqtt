# AGENTS.md

Guide for AI agents working on this codebase. Read this before writing any code.

## Rules — Read These First

### 0. Performance is a feature — not an afterthought
Every change must consider performance impact BEFORE implementation. A single O(n²) loop or per-item API call can freeze the UI or stall the server.

**Before writing code, ask:**
- What's the worst-case data size this code will process?
- Am I adding work inside a hot loop?
- Am I fetching from the server what I could compute client-side?
- Am I recomputing something that could be cached/incremental?
- Does my change invalidate caches more broadly than necessary?

**Hard rules:**
- **No per-item API calls.** Fetch bulk, filter client-side.
- **No O(n²) in hot paths.** Use Maps/Sets for lookups, not nested array scans.
- **No full DOM rebuilds.** Diff or virtualize — never innerHTML entire tables.
- **No unbounded data structures.** Every data structure must have eviction or size limits.
- **No expensive work under locks.** Copy data under lock, process outside.
- **Cache expensive computations.** Invalidate surgically, not globally.
- **Debounce/coalesce rapid events.** Messages, scroll, resize — never fire raw.

**If your change touches a hot path, include a performance justification in the PR description:** what the complexity is, what the expected scale is, and why it won't degrade.

**Performance claims require proof.** "This is faster" without data is not acceptable. Every PR claiming to fix or improve performance MUST include measurable evidence (benchmark test, profile output, or timing measurements).

### 1. No commit without tests
Every change that touches logic MUST have tests. If you add new logic, add tests. No exceptions.

### 2. No commit without browser validation
After pushing, verify the change works in an actual browser. Take a screenshot if the change is visual. If you can't validate it, say so — don't claim it works.

### 3. Cache busters are automatic — do NOT manually edit them
If your project uses automatic cache busting, do NOT replace placeholders with hardcoded timestamps.

### 4. Verify API response shape before building UI
Before writing client code that consumes an API endpoint, check what the endpoint ACTUALLY returns. Don't assume fields exist — different query parameters can return different field sets. This has caused multiple breakages.

### 5. Plan before implementing
Present a plan with milestones to the human. Wait for sign-off before starting. The plan must include:
- What changes in each milestone
- What tests will be written
- What browser validation will be done
- What configuration implications exist

Do NOT start coding until the human says "go" or "start" or equivalent.

### 6. One commit per logical change
Don't push half-finished work. Don't push "let me try this" experiments. Get it right locally, test it, THEN push ONE commit. Pushing multiple commits for a single change increases review burden.

### 7. Understand before fixing
When something doesn't work as expected, INVESTIGATE before "fixing." Read the source. Check the actual data. Understand WHY before changing code. Many bugs happen because we guessed at behavior instead of reading the source.

### 8. Config values belong in configuration
If a feature introduces configurable values (thresholds, timeouts, display limits), note in the plan that these should be exposed in configuration in a later milestone. It's OK to hardcode initially, but don't forget — track it in the plan.

### 9. Explicit git add only
Never use `git add -A` or `git add .`. Always list files explicitly: `git add file1.js file2.js`. Review with `git diff --cached --stat` before committing.

### 10. Don't regress performance
Don't add per-item API calls. Don't add O(n²) loops. Client-side filtering is preferred over server-side. If you need data from the server, fetch it once and cache it.

### 11. PR descriptions must be clean markdown
When opening a pull request, the description must be **valid, readable markdown**. Use real newlines (not `\n` literals), proper code fences, and correct heading syntax. If the description renders as garbage, fix it before requesting review.

### 12. Post a follow-up comment when review feedback is addressed
When you push fixes for review comments, post a comment on the PR listing what was changed and the commit hash. Reviewers should not have to dig through commits to find what was fixed. Format: "Review feedback addressed (commit `abc1234`)" followed by a numbered list of what was done.

### 13. Use git worktrees for parallel work — never pollute the main checkout
Multiple agents work in parallel. The main clone must stay on the main branch and never be modified directly.

**Implementation agents** must create a dedicated worktree before making any changes:
```bash
git worktree add _wt-<branch-name> -b <branch-name> origin/main
cd _wt-<branch-name>
# ... do all work here ...
```
After PR is merged, clean up: `git worktree remove _wt-<branch-name>`

**Review agents** must NEVER read files from the working tree. Use git commands to read the remote branch directly:
```bash
git fetch origin <branch>
git show origin/<branch>:<path/to/file>      # read a specific file
git diff origin/main..origin/<branch>       # see the full diff
```
The working tree may have a different branch checked out. Reading it will give you wrong code.

**Periodic cleanup**: run `git worktree prune` to remove stale worktree references.



## Testing

### Rules
**ALL existing tests must pass before pushing.** No exceptions. No "known failures."

**Every new feature must add tests.** Unit tests for logic, integration tests for UI changes. Test count only goes up.

**Coverage targets:** Both backend and frontend coverage should only go up. CI reports both and updates badges automatically.

### When writing a new feature
1. Write the feature code
2. Write unit tests for the logic
3. Write/update integration tests if it's a UI change
4. Run all tests — all tests must pass
5. THEN push to main

### Testing infrastructure
- **Backend coverage**: tracks server-side code in-process
- **Frontend coverage**: instruments frontend files → exercises them → extracts coverage → reports. Instrumented files are generated fresh each CI run, never checked in.
- **CI pipeline**: backend tests + coverage → instrument frontend → start local server → integration tests + coverage collection → badges update → deploy (only if all pass)
- **Integration tests default to localhost** — NEVER run against prod. Running locally: start your server, then run integration tests

### What Needs Tests
- Parsers and decoders
- Threshold/status calculations
- Data transformations
- Anything with edge cases (null handling, boundary values)
- UI interactions that exercise frontend code branches

## Engineering Principles

These aren't optional. Every change must follow these principles.

### DRY — Don't Repeat Yourself
If the same logic exists in two places, it MUST be extracted into a shared function. Having multiple implementations of the same logic is a maintenance nightmare and a bug factory. One implementation, imported everywhere.

**Before writing new code, search the codebase for existing implementations.** `grep -rn 'functionName\|pattern' ` takes 2 seconds and prevents duplication.

### SOLID Principles
- **Single Responsibility**: Each function does ONE thing. A 200-line function that fetches, transforms, renders, and caches is wrong. Split it.
- **Open/Closed**: Add behavior by extending, not modifying. Use callbacks, options objects, or configuration — not conditional branches based on caller inside shared code.
- **Dependency Injection**: Functions should accept their dependencies as parameters, not reach into globals. This makes functions testable in isolation.
- **Interface Segregation**: Don't force callers to depend on things they don't need. If a function returns 20 fields but the caller uses 3, consider a simpler return shape or let the caller pick.

### Code Reuse
- **Shared helpers go in shared files.**
- **Don't copy-paste between files.** If two files need the same algorithm, import it from a shared module. If the shared module doesn't exist yet, create one.
- **Parameterize, don't duplicate.** If two callers need slightly different behavior, add a parameter — don't fork the function.

### Testability
- **Write functions that are easy to test.** Pure functions (input → output, no side effects) are ideal. If a function reads from the DOM, the DB, and localStorage, it's untestable without mocking everything.
- **Dependency injection enables testing.** Pass dependencies as parameters. Tests can substitute fakes.
- **Test the real code, not copies.** Don't paste a function into a test file and test the copy. Import/require the actual module. If the module isn't importable, refactor it so it is.
- **Every bug fix gets a regression test.** If it broke once, it'll break again. The test proves it stays fixed.

### Type Safety (without TypeScript)
- **Cast at the boundary.** Data from external sources (DB, API, localStorage) may be strings when you expect numbers. Cast early: `Number(val)`, `parseInt(val)`, `String(val)`. Don't let type mismatches propagate deep into logic where they cause errors.
- **Null-check before method calls.** Check for null/undefined before calling methods.

### Performance Awareness
- **No per-item API calls.** Fetch bulk data once, filter/transform client-side.
- **No O(n²) in hot paths.** A nested loop over large datasets can cause performance issues. Use Maps/Sets for lookups.
- **Cache expensive computations.** If you compute the same thing repeatedly, cache it and invalidate on data change.

## XP (Extreme Programming) Practices

### Test-First Development
Write the test BEFORE the code. Not after. Not "I'll add tests later." The test defines the expected behavior, then you write the minimum code to make it pass.

**Flow:** Red (write failing test) → Green (make it pass) → Refactor (clean up).

This prevents shipping bugs like `.toFixed on a string` — if the test existed first with string inputs, the bug could never have been introduced. Every bug fix starts by writing a test that reproduces the bug, THEN fixing it.

### YAGNI — You Aren't Gonna Need It
Don't build for hypothetical future requirements. Build the simplest thing that solves the current problem. Duplicate implementations often happen because each file rolls its own "just in case" version instead of importing an existing one.

If you're writing code that handles a case nobody asked for: stop. Delete it. Add it when there's a real need.

### Refactor Mercilessly
When you touch a file and see duplication, dead code, unclear names, or structural mess — clean it up in the same commit. Don't leave it for "later." Later never comes. Tech debt compounds.

**The Boy Scout Rule:** Leave every file cleaner than you found it.

### Simple Design
The simplest solution that works is the correct one. Complexity is a bug. Before building something, ask:
1. Does this already exist somewhere in the codebase?
2. Can I solve this with an existing function + a parameter?
3. Am I over-engineering for a case that doesn't exist yet?

If the answer to any of these is yes, simplify.

### Pair Programming (Human + AI Model)
For this project, pair programming means: **subagent writes the code → parent agent reviews and tests locally → THEN pushes to main.** The subagent is the "driver," the parent is the "navigator."

**What this means in practice:**
- Subagent output is NEVER pushed directly without review
- Parent agent runs the tests, checks the diff, verifies the behavior
- If the subagent's work is wrong, parent fixes it before pushing — not after
- "The subagent said it works" is not verification. Running the tests is.

### Continuous Integration as a Gate
CI must pass before code is considered shipped. But CI is the LAST line of defense, not the first. The process is:
1. Test locally (unit + integration)
2. Review the diff
3. Push
4. CI confirms

If CI catches something you missed locally, that's a process failure — figure out why your local testing didn't catch it and fix the gap.

### 10-Minute Build
Everything must be testable locally in under 10 minutes. If local tests are broken, flaky, or crashing — that's a P0 blocker. Fix the test infrastructure before shipping features. Broken tests = no tests = shipping blind.

### Collective Code Ownership
No file is "someone else's problem." Every file follows the same patterns, uses the same shared modules, meets the same quality bar. If a file drifts from the shared patterns, bring it back in line.

### Small Releases
One logical change per commit. Each commit is deployable. Each commit has its tests. Don't bundle "fix A + feature B + cleanup C" into one push — if B breaks, you can't revert without losing A and C.

## Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Forgot cache busters | If using automatic cache busting, verify it works |
| Missing API fields | Check the actual API response first |
| Date/time field mismatches | Always verify which timestamp field to use |
| CSS selectors don't match SVG | Manipulate SVG in JS after generation |
| Feature built on wrong assumption | Read source/data before coding |
| Pushed without testing | Run tests + browser check every time |
| Tests defaulting to prod | Always default to localhost, never prod |
| Gave up testing locally | Basic tests work on most systems |
| Copy-pasted functions for "coverage" | Test the real code, not copies in a helper file |
| Subagent timed out mid-work | Give clear scope, don't try to run slow pipelines locally |

## File Naming
- Tests: `test-{feature}.js` in repo root
- No build step, no transpilation — write modern JavaScript for server, ES5/6 for frontend (broad browser support)

### Deep Linking
All new UI states that a user might want to share or bookmark MUST be reflected in the URL hash.
This includes: tabs, filters, selected items, view modes. Use query parameters on the hash for filter state.

## What NOT to Do
- **Don't check in private information** — no names, API keys, tokens, passwords, IP addresses, personal data, or any identifying information.
- Don't add dependencies without asking
- Don't create a build step
- Don't add framework abstractions without approval
- Don't hardcode colors — use CSS variables
- Don't make per-item server API calls from the frontend
- Don't push without running tests
- Don't start implementing without plan approval
