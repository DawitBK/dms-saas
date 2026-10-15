# Rollout Guide — Shipping Changes Without Breaking Things for Real Users

This doc explains, in plain terms, how to keep improving this app after real people
start depending on it — without a bad deploy taking the app down, and without a
database change you can't take back.

If you only remember one sentence from this whole doc, make it this one:

> **Never make a change that yesterday's code, or yesterday's users, couldn't survive.**

Everything below is just different ways of applying that one idea.

---

## The problem, in plain terms

Right now, if you want to ship a change, you edit the code and restart the app. That's
totally fine while it's just you testing on your own machine. The moment other people
are actually using this app, three things can go wrong that couldn't go wrong before:

1. **Your new code has a bug.** Now instead of just you seeing an error, real people
   are locked out or looking at a broken page.
2. **You changed the database at the same time as the code.** If the new code turns out
   to be broken and you need to go back to yesterday's version, yesterday's code might
   not understand today's database anymore. You're stuck — can't go forward (it's
   broken) and can't go back (the database moved on).
3. **You're changing one part of the app (say, Documents) and it quietly breaks another
   part that was already working fine (say, Letters/CAMS)** — because a lot of code is
   shared underneath, and nothing was watching for that.

This doc is the plan for all three. Nothing here is theoretical — it's written against
what's actually in this codebase today, including the parts that currently aren't safe
yet.

---

## 1. What's true about this codebase right now

Being honest about where things stand before proposing fixes:

- **Every API endpoint lives under `/api/v1`.** That's good — it means there's already
  a "version" concept, it's just never been used as one yet.
- **There is no "undo" for the database.** I checked — the code that's supposed to roll
  back a database migration is written to immediately throw an error, on purpose, for
  every single migration. So whatever change you make to the database, you can only
  ever go forward. This is the single biggest risk in the current setup, and most of
  this doc is about working around it.
- **There's already a solid automated test that protects CAMS specifically** — a script
  that logs in, creates a letter, submits it, approves it, checks the PDF and QR code,
  registers an incoming letter, and more (27 checks in total). It already runs
  automatically. It's just not being treated as a hard "don't merge if this is red"
  rule yet.
- **There's no Docker setup that actually works yet.** There's a config file that
  describes what a production setup *should* look like (backend, worker, frontend,
  database, redis, file storage, search, virus scanning, all as separate pieces) but
  the actual "how do I package the backend/frontend into something deployable" files
  didn't exist. (They do now — see §5.)
- **There's no version numbering and no changelog.** Both apps are still labeled
  version `0.1.0`, like a project that hasn't shipped yet.
- **There's basically no "feature flag" system** — meaning no way to ship a new feature
  to production without it being instantly live for every single user the moment you
  deploy. There's one small example of this idea (an AI setting per customer) but
  nothing general-purpose.
- **The frontend calls the backend through one environment setting**
  (`NEXT_PUBLIC_API_BASE_URL`), which is good, but the fallback web address was
  copy-pasted into 7 different files instead of written once. Small thing, but it means
  if you ever needed to change it, you'd have to remember all 7 places.

---

## 2. API versioning — think of `/api/v1` as a promise you made

Your frontend calls your backend and expects specific things back — a letter has an
`id`, a `subject`, a `status`, and so on. As long as you only *add* to what you send
back, nothing that already depends on the old shape breaks. The moment you *change* or
*remove* something that's already there, anything relying on the old shape breaks
immediately, with no warning.

### The one rule that covers 90% of changes

**If you're only adding something, just add it to `/api/v1` — no special process
needed.** That includes:
- A brand new endpoint.
- A new optional field on a request.
- A new field in a response.
- A new possible value for something that's already a flexible field (as long as
  nothing on the frontend has a rigid "if/else" that breaks on values it's never
  seen before — worth a quick look, but generally fine).

**The moment you're renaming, removing, or changing the meaning of something that
already exists, stop and use the plan below instead.** Examples of "this needs the
plan": renaming a field, changing what a status code means, making an optional field
required, or changing what a value like `documentId` actually points to for a letter
that used to point somewhere else.

### The plan for an actual breaking change

1. Don't touch `/api/v1` at all. Whatever's already there for existing users stays
   exactly as it is.
2. Build the new, changed version as `/api/v2` — but only for the one specific thing
   that needed to change (say, just the letters endpoints), not the whole API. Most of
   your `/api/v2` will probably never exist, because most things won't need it.
3. Both versions can call the exact same underlying business logic — you're only
   duplicating the "what does the request/response look like" layer, not the actual
   logic behind it, unless the logic itself is what changed.
4. When you do introduce a v2 for something, mark the old v1 version as "deprecated"
   (there's a standard, simple way to say this in the HTTP response itself) and give it
   at least 90 days before you ever remove it, so nothing breaks for anyone still using
   it.

### One small cleanup worth doing regardless

The web address your frontend falls back to when its configuration is missing
(`http://localhost:7100/api/v1`) was typed out separately in 7 different files instead
of being written once and reused. **This is fixed now** — there's one shared constant
everything imports, so there's only one place to look if this ever needs to change, and
one less way for a misconfigured deployment to silently start talking to
`localhost` by accident.

---

## 3. Database changes — the "no undo" problem, and how to work around it

This is the most important section in this whole document.

Because there's no way to undo a database change, the safety has to come from **never
making a change your old code can't survive**, instead of relying on being able to take
it back. Here's the trick, in plain English:

**Don't change and depend-on-the-change in the same step. Split it into two steps, with
real time in between.**

Say you want to add a new required field to a letter. Doing it all at once — add the
column AND make it required in the same deploy — means: if this deploy has a bug and
you need to go back to yesterday's code, yesterday's code has no idea this new required
field exists, and it'll break trying to save anything.

Instead, split it in two:

**Step one ("expand" — always safe):**
- Add the new column, but let it be optional for now.
- Deploy the code that can use it.
- Let this run for a while. Make sure it's actually stable.

**Step two ("contract" — only once you're confident):**
- Now go back and make it required, clean up whatever old stuff you don't need anymore.
- This step is the one that's genuinely a one-way door. Don't rush into it, and don't
  bundle it together with unrelated changes.

The simple test to run in your head before writing any database migration:

> **"If I had to go back to yesterday's code right now, would it still work against
> this new database?"**

If the answer is no, you're doing a "step two" change too early — split it and wait.

### A safety net that's now in place

Since this is easy to forget under deadline pressure, there's now an automated check
(see §6) that scans every new database migration and stops the build if it finds
something risky — like making a column required, or deleting a column/table — without
an explicit comment explaining why it's safe. It won't catch everything, but it turns
"oops, forgot" into "the computer told me to double check," which is a much better
failure mode.

---

## 4. Keeping a finished module finished (the CAMS example)

You mentioned CAMS specifically — once it's done, you don't want changes somewhere else
in the app to quietly break it. Building a whole separate API version for this would be
overkill; there's a much better tool for it, and you already had the first piece of it
without realizing it.

**The tool is: an automated test that pretends to be a real user of that module, run
every single time any code changes anywhere in the app — not just when someone touches
that module.**

CAMS already has this — a script that logs in, drafts a letter, submits it for
approval, approves it, checks the generated PDF and QR code, registers an incoming
letter, links letters together, and checks the archive filters. 27 real checks, run
against a real running copy of the app. It already runs automatically. The only change
needed is a policy one: **treat it as a hard rule that nobody merges code if this test
goes red — even if their change "obviously" has nothing to do with letters.** That's
exactly the scenario where shared code breaks something unrelated without anyone
noticing until a customer complains.

As other modules become "done, don't touch," write the same kind of test for them.
Each one becomes that module's own guardrail — you stop having to personally remember
"don't break CAMS while I'm working on Documents," because the computer remembers for
you.

### For the riskier stuff: feature flags

Sometimes a change is big enough that even a good test doesn't feel like enough
reassurance — you want to try it on one customer first before it's live for everyone.
That's what a feature flag is: a simple on/off switch, stored in the database, checked
by your code. When it's off, the old behavior runs, unaffected by whatever new code you
shipped. When it's on for one customer, only that customer sees the new behavior.
Nobody else is affected either way.

This is now built (see §6) as a small, reusable service — any part of the app can ask
"is this feature on for this customer?" and get an instant, cached yes/no answer. New
flags default to **off**. Turning a flag on or off is just a database update — instant,
no deploy, no redeploy, no waiting.

This is really the answer to "how do I keep shipping without breaking what's already
live": you stop shipping *behavior* directly to users. You ship *code*, dark, behind a
switch that's off. You turn the switch on for one customer, watch it, then turn it on
for everyone once you're confident. If something's wrong, you flip it back off — done,
no rollback needed at all.

---

## 5. Releasing, deploying, and rolling back

### Give every release a real version number

Both apps are still sitting at version `0.1.0`. From here on, use real version numbers
(`1.0.0`, `1.1.0`, `1.1.1`, and so on) and a real changelog — a simple text file
(`CHANGELOG.md`, now created) that lists what changed in each release, in plain
English, so anyone (including future-you) can see what shipped and when without
digging through commit history.

- Bump the last number for a small fix.
- Bump the middle number for a new feature that doesn't break anything old.
- Bump the first number for anything that involved a `/api/v2` or removing something
  that used to exist.

### Package the app once, and reuse that exact package everywhere

Right now, "deploying" would mean rebuilding the app fresh wherever it runs — which
means you can never be 100% sure the version running in production is byte-for-byte
the same as the version that passed all your tests. The fix is to **build the app into
one package (a Docker image) exactly once, and use that exact same package everywhere**
— on your test server, and then in production. You never rebuild for production; you
just point production at the package that already proved itself on the test server.

This required writing the actual packaging instructions for both the backend and the
frontend (they didn't exist before — **they do now**, see §6), since the file that
described the overall setup was assuming they already existed.

### Rolling back, for real

Because there's no "undo" for the database (§3), the real rollback mechanism is much
simpler than it sounds: **keep the last several packaged versions around, and if
something's wrong, just switch back to running the previous one.** No rebuilding, no
touching the database, no drama. This only works if you've actually been following the
database rule in §3 — the old package has to still be able to run against whatever the
database currently looks like, which is exactly what that rule guarantees.

Before any new version starts receiving real traffic, it should have to pass a basic
health check first (the backend already has one built in) — so a broken deploy never
even gets the chance to serve a real user, instead of finding out from a complaint.

---

## 6. What's now actually built (not just planned)

Everything below used to be a plan. It's now real, in this repo:

| What | Where | What it does |
|---|---|---|
| Shared frontend API base URL constant | `frontend/shared/lib/apiConfig.ts` | One place for the fallback API address, instead of 7 copies. |
| Backend Dockerfile | `backend/Dockerfile` | Packages the backend into one deployable image (multi-stage: install → build → slim runtime). |
| Frontend Dockerfile | `frontend/Dockerfile` | Same idea, for the Next.js frontend. |
| Migration safety check | `backend/scripts/check-migration-safety.ts`, wired into `.github/workflows/ci.yml` | Scans new migrations for risky patterns (making a column required, dropping something, renaming something) and fails the build unless there's a comment explaining why it's safe. |
| Feature flag service | `backend/migrations/<latest>-feature-flags.sql`, `backend/src/modules/feature-flags/` | Per-customer on/off switches for risky features, cached, instant to flip. |
| Changelog | `CHANGELOG.md` | Plain-English log of what shipped in each version. |
| Real version numbers | `backend/package.json`, `frontend/package.json` | Both bumped to `1.0.0` as the first "real" tracked release. |

See each area's own README/comments for exact usage — this doc is the "why," the code
is the "how."

---

## 7. The checklist for your next release

Literally follow this list, in order, every time you're about to ship something to
production:

- [ ] Any new database migration passes the automated safety check, or has an explicit
      comment justifying why the risky thing it's doing is actually safe.
- [ ] All the automated module checks (CAMS's and any others you've since written) are
      green.
- [ ] Anything you're genuinely unsure about is behind a feature flag, defaulted off.
- [ ] `CHANGELOG.md` reflects what's actually shipping.
- [ ] Version number bumped in both `package.json` files.
- [ ] The packaged app (Docker image) is built once and tagged with that version.
- [ ] It's tried out on a test/staging copy first — same package, not a rebuild.
- [ ] Production is pointed at that exact same package — still not a rebuild.
- [ ] The health check passes before real traffic reaches it.
- [ ] You've confirmed the previous version's package is still available, just in case.
- [ ] Git tag pushed, changelog entry dated and closed out.
Everything's done and verified. Summary:

Documentations/rollout.md — rewritten in plain language (no jargon left unexplained), same content, easier to actually read.

Every risk it raised is now fixed, not just documented:

No DB rollback → migrations can now ship a real .down.sql companion that migrate down actually runs; tested by rolling back and reapplying live.
No migration safety net → db:migrate:check scans new migrations for destructive patterns, wired into CI.
No Dockerfiles despite docker-compose.yml assuming them → both written, verified against real build output (frontend's standalone layout, backend's workspace-aware multi-stage build), and docker-compose.yml's build contexts fixed to match.
No feature-flag system → built one (migration + model + cached service), so risky changes can ship dark and get turned on per-tenant.
No versioning → CHANGELOG.md added, both package.jsons at 1.0.0. I did not commit or tag — that's a git action I'll leave for you to trigger explicitly.
7 duplicated API-URL fallbacks → one shared constant.
One serious bug found during verification, not in the original list: Redis going down was hanging every authenticated request indefinitely (token revocation checks, rate limiting, and several caches all shared one connection configured for BullMQ's infinite-patience needs). Fixed by splitting into two connections — queues keep their patient one, everything else now fails fast and degrades the way its own fallback code already intended. Confirmed by actually taking Redis down and hitting the app: request latency dropped from indefinite hangs to milliseconds, and the full test suite got noticeably faster.

Final state: both backends typecheck clean, all 19 backend test suites / 146 tests pass, verify-cams.ts (27 live checks) passes, migration safety check passes. Two of those test failures were real regressions from my own changes (a stale role-count fixture, two test mocks missing a new export) — fixed, not papered over.