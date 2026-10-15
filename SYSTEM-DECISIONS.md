# DMS — System Decisions (Owner Interview, 2026-07-15)

**Status: authoritative and current.** These are the owner's confirmed answers to
the open design questions raised by the July 2026 approval-engine review, and they
are what the code implements. `modules/approvals/` and six database models cite this
document by decision number (`SYSTEM-DECISIONS.md D1`, `D1–D7`, `D5–D7` …), so the
numbering is load-bearing — do not renumber the decisions.

The review documents this one grew out of (a walkthrough of the pre-engine system and
a set of proposals) have been removed: the system they described no longer exists, and
every question they raised is answered below. The [Divergences](#divergences-from-the-original-proposals)
table records the points where a decision overrode the original proposal, stating both
sides, so nothing is lost by their absence. For how the engine works *now*, read
`ARCHITECTURE.md` and `DMS/CLAUDE.md`.

---

## Table of contents

1. [The approval engine](#1-the-approval-engine)
2. [The audit stage](#2-the-audit-stage)
3. [Signing](#3-signing)
4. [Access & notices](#4-access--notices)
5. [Governance housekeeping](#5-governance-housekeeping)
6. [Program order](#6-program-order)
7. [Divergences from the original proposals](#divergences-from-the-original-proposals)

---

## 1. The approval engine

### D1 — Chain model: template + author completion

For every document, letter, and form type, an admin defines a default approval recipe once: an ordered list of steps, each specifying who acts (a role like "Dept Manager" or a named person), what kind of step it is (Review or Approve), a deadline, and whether the author may change it. Steps the company insists on (e.g. "Records Manager approves last") are **locked**. When the author submits, they see the pre-filled chain and personalize the unlocked parts — swap a role for a specific person, add optional extra steps, reorder the optional ones. Locked steps cannot be removed, changed, or skipped. The company keeps its mandatory approvers; the author still picks their people.

### D2 — Re-approval after editing an approved document: per-type setting

Each document type carries `reapprovalPolicy: none | major_versions | all_changes`:
- `none` — edits to an approved document never re-run the chain (informal working documents);
- `major_versions` — minor versions (2.0 → 2.1) are free, a major version (2.0 → 3.0) goes back through the chain (procedures, policies);
- `all_changes` — any edit whatsoever re-runs the chain (contracts, invoices).

### D3 — Decline is revisable

Decline is the hard "no" (with a mandatory comment), distinct from Request Changes. A DECLINED item is not dead: the author may rework it and resubmit, which starts a completely fresh chain. Everything stays on one item with one visible history — submitted → declined (reason) → edited → resubmitted → approved.

### D4 — List display: one status, plus a progress hint

While a chain is running, list pages show a single status chip, **IN REVIEW**, from submit until the final decision — whether zero or two of three approvers have acted. A small progress hint sits beside it ("2/3 · waiting on Alemu"). The item's own page always shows the full stepper: completed steps green with decision, comment, and timestamp; the current step highlighted ("waiting on X since …"); future steps grey. No separate "IN PROGRESS" status is introduced.

The full state vocabulary (documents, letters, and forms alike): `DRAFT → IN_REVIEW → APPROVED`, with `CHANGES_REQUESTED` (bounced to author, chain suspended) and `DECLINED` (hard-rejected, revisable) as the two exits.

---

## 2. The audit stage

### D5 — When audit happens: per-type policy

Two new lifecycle states, `PENDING_AUDIT` and `AUDITED`, sit between approval and archive. Each type declares `auditPolicy: required | optional | never`:
- `required` — every approved item of this type must pass audit before it can be archived;
- `optional` — at final approval, the final approver chooses "send to audit" or "no audit needed → archive-eligible";
- `never` — the audit stage is skipped entirely.

### D6 — Auditor selection: the final approver picks

When an item goes to audit, the **final approver personally selects a named auditor** from the users holding the auditor capability. There is no auto-assignment and no shared claim-queue. The system still enforces independence: an auditor can never audit an item they drafted or approved, and audit decisions write their own dedicated audit-log events.

### D7 — A FLAG goes back to the final approver

When the auditor finds a problem, they **Flag** the item with mandatory written findings, and it returns to the **final approver** — the person who approved it owns the remediation. The approver reads the findings and decides how to fix it (doing it themselves or pulling in the drafter). After remediation the item re-enters audit with the same approver-picks-auditor flow. **Pass** makes the item archivable.

---

## 3. Signing

### D8 — "Signed" means the e-signing ceremony, per document type

When a document completes its approval chain, whether it must then be **signed** is a per-document-type setting. For types that require it, approval automatically triggers the existing DocuSign-style e-signing ceremony (signature fields placed on the PDF, named recipients — internal or external — invited, serial or parallel order, tracked to completion): the item enters `PENDING_SIGNATURE` after approval and becomes `SIGNED` when everyone has signed. Types that don't require it are simply done at `APPROVED`.

### D8b — The QR authenticity stamp stays letters-only

The letters treatment at final approval — signatory block, content fingerprint (hash), and public QR "scan to verify" — **remains exclusive to letters/correspondence**. It is *not* extended to generic documents or forms.

### D8c — Handwritten signature images: yes

Each user may optionally upload an image of their handwritten signature to their profile. It renders in the signature block of letters they finally approve and in the e-signing ceremonies they complete. Cosmetic — the underlying guarantees are unchanged — but it gives PDFs the expected signed look.

### D8d — The PKI subsystem stays parked

The internal-PKI signing subsystem (self-managed CA, real RSA signatures) is implemented and API-reachable — `signing.service.ts` has a working `PKI_DIGITAL` signing type behind the permission-gated `POST /signing/:documentId/sign` route — but has **no frontend entry point**: no UI anywhere sends `signingType: 'PKI_DIGITAL'`, so a caller can only reach it directly against the API, not through a button. It is deliberately kept unwired-from-the-UI as a head start for a possible future PAdES build (cryptographic signatures embedded in PDF bytes, Acrobat-verifiable). No PAdES investment now.

---

## 4. Access & notices

### D9 — Chain visibility follows item visibility

One rule everywhere: if you are allowed to open an item — including CONFIDENTIAL and RESTRICTED ones — you may also see its full approval chain (names, emails, decisions, comments). No participants-only masking.

### D10 — Executive notices become configurable

The automatic "every finally-approved letter emailed to every EXECUTIVE" behavior is replaced with configuration: per letter type and per confidentiality threshold (CONFIDENTIAL/RESTRICTED letters are never auto-emailed), with a per-executive opt-out. Executives keep their read access to the register regardless.

---

## 5. Governance housekeeping

### D11 — Retention triggers: all four; no administrative holds

Retention schedules may start their clock from any of: **creation date**, **archive date**, **the document's own date** (e.g. contract signing date), and **case/matter closed**. The first three can be implemented directly; case-closed requires a case/matter concept that does not exist yet and is sequenced last. There will be **no separate administrative hold** — legal hold remains the single freeze mechanism; non-legal freezes (migrations, internal reviews) use a legal hold with an appropriate reference.

### D12 — Trash windows stay fixed; purges get maker–checker

The 30-day trash window and 7-day cooling period stay **hardcoded** as they are (no tenant configurability). Manual immediate purges gain a **maker–checker rule**: the person who stages a permanent destruction cannot be the person who approves it — a second authorized person must confirm.

### D13 — Ingestion: all channels are real at Example Corp

Paper and correspondence arrive through **all** of: dedicated scan operators / records clerks, department office scanners, and email attachments — alongside plenty of born-digital content. Suggested build order: **(1)** batch-upload flow for scan operators (many files, shared metadata, per-file review), **(2)** monitored-mailbox email ingestion, **(3)** watched network folders for department scanners.

---

## 6. Program order

### D14 — One continuous program: P0 first, then P1

The work runs as a single program with no pause between phases:

1. **P0 — foundations** (unchanged from the original proposal): retention-engine activation, trash/recycle-bin UI + routed purge with maker–checker, re-enabled checkout/version audit writes, assignee/signatory UUID fix, Governance-tab data, `scan_pending` promotion, delete-button route, `assertACLAllow` ancestry.
2. **P1 — the vision, scoped by this document**: unified approval engine per D1–D4, audit stage per D5–D7, per-type signing per D8/D8b–D8d, unified "My Work" inbox, forms through the engine.

---

## Divergences from the original proposals

The following proposed behaviours are **superseded** by the decisions in this document:

| # | Recommendation said | Decision is |
|---|---|---|
| D6 | Auto-assign auditors (round-robin/least-loaded), approver may pick (§3.2) | **Final approver always picks a named auditor** — no auto-assignment, no pool queue |
| D7 | FLAG returns the item to the drafter/final-approver (§3.3, leaning drafter) | **FLAG returns to the final approver**, who owns remediation |
| D8 | Layer 1 (signatory + hash + QR) is the default meaning of "signed"; ceremonies reserved for contracts/external (§4.1–4.2) | **"Signed" = the e-signing ceremony, triggered by approval, configurable per document type** |
| D8b | Extend the hash + QR authenticity layer platform-wide to documents and forms (§4.1) | **QR/hash verification stays letters-only** |
| D8d | Either revive the PKI subsystem into layers 1–2 or delete it ("a dead-but-present crypto subsystem is a liability", §4.3) | **Keep it parked** — implemented and API-reachable (`PKI_DIGITAL` via `POST /signing/:documentId/sign`), but no UI entry point; retained for a possible future PAdES build |

Consequential note: because D8b drops the platform-wide authenticity layer, the proposed "approval authenticity layer for documents/forms (hash + QR + signatory)" was **removed from P1 scope**; the public `/verify` page serves letters only.

---

## Implementation status (2026-07-16)

**P0 — all eight foundation fixes shipped** (retention engine activation + backfill, Recycle Bin UI + `GET /documents/trash`, routed staged-purge with maker–checker (`staged_by_id`, stager ≠ approver), re-enabled checkout/version audit writes, letters assignee/signatory eager-loading, Governance-tab `signatures`/`legalHolds`, `SCAN_PENDING` state + worker promotion + row-normalization migration, `assertACLAllow` → `resolveACL` delegation).

**P1 — implemented per D1–D14:**
- D1–D4: `modules/approvals` engine (templates with locked steps → author completion → sequential steps → APPROVE / REQUEST_CHANGES / DECLINE), new document states `CHANGES_REQUESTED`/`DECLINED`, self-service submit, chain stepper + submit modal UI, D4 list hint. Migration `20260716000001-unified-approval-engine.sql`.
- D5–D7: audit stage (`PENDING_AUDIT`/`AUDITED`/`AUDIT_FLAGGED`, `audit_stage_reviews`, per-type `auditPolicy`, approver-picked auditor, PASS/FLAG with mandatory findings, flag → final approver, independence enforced).
- D8/D8b/D8c/D8d: `signingPolicy` per type triggers the e-sign ceremony after approval (completion → SIGNED → audit/ACTIVE; decline → SIGNING_DECLINED); QR stays letters-only; signature images live (profile upload + letter PDF render); PKI subsystem remains parked.
- D9: chain visibility = item visibility (getChain runs the item's own access check).
- D10: executive notices configurable per tenant + per-executive opt-out.
- D11: retention triggers live for creation / archive / document-date; **case-closed deferred** until a case/matter concept exists. No administrative holds (as decided).
- D12: maker–checker purges live; 30+7-day windows hardcoded.
- Plus: forms through the engine (template approval + `instanceApproval`), "My Work" unified inbox.

**Verified:** backend + frontend typecheck clean; full backend suite 19/19 suites, 146/146 tests.

**Still open (P2/P3 of the recommendations, not decision-blocking):** letters polish (per-tenant letterhead/branding, Amharic Unicode PDF font, rich-text bodies, incoming acknowledge-receipt action, CC/distribution lists, dedicated CLOSED audit event, full `assertTransition` coverage), SLA reminders → escalation that acts + daily digest, tus wiring into the upload wizard, PDF text extraction, disposition PRESERVE decision + CoD register UI, bulk restore, notification preferences, scanner/email ingestion (D13 order: batch upload → mailbox → watch folders), delegation/out-of-office, engine email templates (in-app + websocket notifications ship now), letters migration onto the unified engine (letters keep their proven implementation meanwhile). P-prod: Vault, RLS drill, E2E debts.
