<!-- DMS/DMS. See CONTRIBUTING.md for the full convention this template supports. -->

## What changed and why

<!-- The "why" matters more than the "what" - the diff already shows what changed. -->

## Type of change

- [ ] `feat` — new functionality
- [ ] `fix` — bug fix
- [ ] `chore` / `refactor` — no functional change
- [ ] `docs` — documentation only
- [ ] `test` — test coverage only

## Scope check (Directive §8)

- [ ] This change is purely structural/architectural, OR
- [ ] This change alters existing functional behavior, and that is called out
      explicitly above with the reason why.

## Compliance impact

- [ ] No effect on ACL/permission resolution, audit-log hash chain, or e-signature flow, OR
- [ ] Effect described above, with reasoning for why it preserves ISO 15489 / MoReq2010 /
      ISO 27001 / Electronic Signature Proclamation 1072/2018 compliance.

## Related gap register entry

<!-- e.g. Closes PLATFORM-GAP-006. Leave blank if not applicable. -->

## Verification

<!-- What you actually ran, not what should theoretically pass. -->

- [ ] `npm run typecheck` clean
- [ ] `npm --workspace backend run lint` / `npm --workspace frontend run lint` clean
- [ ] `npm test` green
- [ ] `npm run test:status` run and `Documentations/TEST_STATUS.md` diff committed
      (if the test count/coverage changed)
- [ ] Manually verified against a running instance (describe how below), where the
      change touches user-facing or request-handling behavior

<!-- Paste the actual command output / curl output / screenshot evidence here. -->
