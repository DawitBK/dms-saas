# DMS document encryption, storage, and database — the complete plain-English guide

This is a self-contained reference for how DMS keeps uploaded documents
private, where every piece of that puzzle physically lives, how to put the
pieces back together to read a file, how to back all of it up, and how to
safely change the master key without breaking anything. Everything here was
checked directly against the real code (`documentCrypto.ts`, `VaultService.ts`,
`HashiCorpVaultService.ts`, the `DocumentDek`/`DocumentVersion` models, and
`scripts/rewrap-deks.ts`) — nothing here is guessed.

---

## 1. The big picture, in one paragraph

Every file DMS stores gets scrambled before it touches the disk. Unscrambling
one back into a real PDF/photo needs **three separate pieces working
together** — a locked box (the file), a room key for that one box (stored,
but itself locked, in the database), and a master key that opens the room-key
cabinet (a secret sitting only in one config file, nowhere else). All three,
every time, or the file cannot be read — not by DMS, not by you, not by
anyone.

```
   [ .enc file on disk ]  +  [ document_deks row in the database ]  +  [ VAULT_MASTER_KEY ]
           |                              |                                    |
      the locked box              the box's room key,               the master key that
                                   itself locked in a                unlocks the cabinet
                                   cabinet                            holding the room key
```

---

## 2. The hotel analogy (keep this in your head, everything below is just the technical version of this)

- **Your uploaded file** = a hotel room, locked.
- **The DEK** ("Data Encryption Key") = that one room's own key. Every room
  gets a brand new, one-time key — DMS never reuses a room key for two
  different files.
- **The room key is never left lying around** — it's stored, but locked
  inside a key cabinet (the `document_deks` database table).
- **The KEK** ("Key Encryption Key", a.k.a. the master key,
  `VAULT_MASTER_KEY`) = the one key that opens the cabinet so you can take a
  room key back out. There is exactly one of these (or a small numbered
  handful, if it's ever been rotated) for the entire hotel, not per room.
- **Losing the master key** doesn't destroy any rooms or any room keys —
  but it means the cabinet can never be opened again, so every room key
  inside it is useless, so every room is permanently inaccessible. This is
  why the master key is the single most valuable secret in the whole
  system.

---

## 3. What actually happens when a file is uploaded (encryption)

Code: `backend/src/modules/documents/documentCrypto.ts`, function
`encryptAndStore`.

1. A brand new random room key (DEK) is generated — 32 random bytes, unique
   to this one file, never reused.
2. The file's real bytes get scrambled with that room key using
   **AES-256-GCM** (a standard, well-trusted encryption method that also
   detects if the scrambled bytes are ever tampered with).
3. The scrambled result is saved to disk as
   `{first 12 bytes: a random "IV"}{next 16 bytes: a tamper-check tag}{the rest: the actual scrambled file}`,
   under a filename ending in `.enc`.
4. The room key itself then gets locked ("wrapped") using the current
   master key, and that locked room key — never the plain, usable one — is
   what actually gets saved to the database, in the `document_deks` table.
5. The plain, usable room key is wiped from memory immediately after. It
   never gets written anywhere unlocked.

## 4. What happens when someone downloads/previews a file (decryption)

Code: same file, function `fetchAndDecrypt` (called from
`documents.service.ts`).

1. Look up the file's row in `document_versions` to get its `storageKey`
   (basically, its filename/address on disk).
2. Read the scrambled `.enc` file from disk.
3. Look up that version's row in `document_deks` to get its locked room key
   and which master-key version locked it.
4. Use the matching master key to unlock ("unwrap") that room key.
5. Use the now-unlocked room key to unscramble the actual file
   (AES-256-GCM decrypt).
6. Double-check the unscrambled file's checksum matches what was recorded at
   upload time (catches silent corruption).
7. Hand the real file back to whoever asked for it. The unlocked room key is
   wiped from memory again immediately after.

---

## 5. Where every piece physically lives — reference table

| Piece | Lives where | Notes |
|---|---|---|
| The scrambled file | `backend/storage/dms-documents/{storageKey}.enc` on the server's disk (or MinIO, if that's reachable — falls back to local disk otherwise) | `storageKey` looks like `FIN/CONTRACT/{documentId}/{versionId}/filename.pdf` |
| That file's row saying where it is | `document_versions` table, columns `storage_key`, `original_filename`, `sha256_hash`, `plaintext_sha256` | One row per version — a document with 3 versions has 3 of these |
| That version's locked room key | `document_deks` table, columns `encrypted_dek` (the locked key, as text), `kek_id` (which master key locked it, e.g. `"env:v1:master"`) | One row per **version**, not per document — matters if you ever look something up by document instead of version |
| The master key(s) | `backend/.env.production` (or `.env.prod` if running the Docker path instead), as `VAULT_MASTER_KEY` (version 1) and optionally `VAULT_MASTER_KEY_V2`, `_V3`, etc. if ever rotated | **The one piece with no other copy anywhere.** Not in the database, not in git. |

Two config files exist in this repo for DMS — `backend/.env.production` (the
plain "just run Node directly" path this platform actually uses) and root
`.env.prod` (an alternate, fully-Dockerized path). Both currently have real
values filled in. **Before touching anything below, confirm which one your
actual running server reads** — if it's a plain console-window `node
dist/src/main.js` process, it's `.env.production`; if it's started via
`docker compose -f docker-compose.prod.yml up`, it's `.env.prod`. Only edit
the one that's actually live, or you'll change a key nothing is reading.

---

## 6. What happens if you lose each piece — a straight-talk table

| You lose... | What happens | Can you recover? |
|---|---|---|
| The `.enc` file only | That one file's content is gone | Only from a file backup (§8 in the deployment guide) |
| The `document_deks` row only | That one file's room key is gone — file is unreadable even though it still exists on disk | Only from a database backup |
| **The master key (`VAULT_MASTER_KEY`, all versions)** | **Every single encrypted document, system-wide, past and future, becomes permanently unreadable** | **No.** Not from any backup of the files or the database — those backups are useless without the key that unlocks them. |

This is why, of the three, the master key deserves the most paranoid
handling — written down somewhere completely separate from the server
(password manager, sealed printed copy in a safe), never relying on it only
existing inside the one `.env` file that also happens to hold everything
else.

---

## 7. How to manually decrypt one file (for recovery, spot-checks, audits)

A ready-to-run script already exists in this repo for exactly this:
`backend/scripts/dr-decrypt-version.ts`. It reuses the app's own tested
decrypt code rather than re-implementing the crypto by hand, so it keeps
working correctly even after a key rotation.

```powershell
Set-Location backend
node scripts/run-with-env.cjs production tsx scripts/dr-decrypt-version.ts <versionId> C:\recovered\myfile.pdf
```

If you only know the document, not the specific version, find the version
id first:
```sql
SELECT id, version_number, original_filename, storage_key
FROM document_versions WHERE document_id = '<documentId>' ORDER BY version_number;
```

Run this wherever the real `.env.production`/`.env.prod` (with the real
master key) and the database (live, or a restored backup) are both
reachable.

---

## 8. Backing everything up (so recovery is possible in the first place)

You need all three pieces backed up, **and kept in sync with each other**:

1. **The database** (`dmsprod`) — holds `document_versions` + `document_deks`.
   The platform's daily scheduled backup set, where one is installed, dumps it as `postgres`.
2. **The storage folder** — holds the `.enc` files. Each dated set of that backup carries a FULL snapshot of it (seven sets are kept);
   the owner copies the backup folder off the server by hand.
3. **The master key** — back this up completely separately from #1 and #2.
   If you ever rotate it (§9 below), make sure your backed-up copy always
   reflects **every version that's ever existed**, not just the newest one —
   an old backup of the database might still have rows wrapped under an
   older key version, and you'd need that old key to read them.

A backup of the database and files taken **at different times** than each
other is still fine to restore from — but restoring the database from
*before* a key rotation while the files on disk are from *after* one (or
vice versa) can mismatch which key version a `document_deks` row expects
versus what's actually configured. Keep the three backups reasonably close
together in time, and always keep every historical master-key version around
indefinitely, just in case.

---

## 9. How to safely change (rotate) the master key

**The one thing you must never do: just edit `VAULT_MASTER_KEY` in place and
restart.** The instant you do that, every existing `document_deks` row —
locked under the *old* value — becomes unopenable, because the app now only
knows the *new* value. That's the same as literally losing the master key
for every document that already existed. There is no "keep both" unless you
follow the numbered-version process below, which is exactly what it's for.

### The safe way, step by step

**Step 1 — add the new key as a new numbered version, don't replace the old one.**

In `backend\.env.production` (or `.env.prod` for the Docker path — see
the note on which is which in §5), keep the existing line exactly as-is and
add a new one:
```
VAULT_MASTER_KEY=<your current, existing value — leave untouched>
VAULT_MASTER_KEY_V2=<a new, freshly generated random string, e.g. from `openssl rand -base64 48`>
```
(For the Docker path, the file only needs `VAULT_MASTER_KEY_V2=...` added
the same way — `docker-compose.prod.yml` already knows how to pass any
`_V{n}` variable through.) The value can be any string at least 32
characters — it gets hashed internally to produce the real 32-byte key, it
does not need to look like hex or base64 itself, though using a proper
random generator is still the right move.

**Step 2 — point the app at the new version as the "current" one for new files.**

Still in the same env file:
```
DEV_VAULT_MASTER_KEY_CURRENT_VERSION=2
```
(For the Docker path, the equivalent line in `.env.prod` is
`VAULT_MASTER_KEY_CURRENT_VERSION=2` — `docker-compose.prod.yml` renames it
to the line above automatically inside the container.)

**Step 3 — restart the app.**

Close and reopen the DMS backend's console window (or
`docker compose -f docker-compose.prod.yml up -d --force-recreate backend`
for the Docker path). From this moment on, every **newly uploaded** file
gets its room key locked with the new master key. Every file uploaded
*before* this moment is still locked with the old one — untouched, still
perfectly readable, because the old key value is still sitting in the env
file right below the new one.

**Step 4 — migrate (rewrap) every existing file's room key onto the new master key.**

This is the part that actually finishes the rotation — it goes through
every old `document_deks` row, unlocks each room key with the *old* master
key, and re-locks it with the *new* one, so eventually nothing depends on
the old key anymore. There's a real script for this already,
`backend/scripts/rewrap-deks.ts`. Always dry-run first:

```powershell
Set-Location backend
node scripts/run-with-env.cjs production tsx scripts/rewrap-deks.ts
```
This only *reports* how many rows still need migrating — it changes
nothing. When you're ready for real:
```powershell
node scripts/run-with-env.cjs production tsx scripts/rewrap-deks.ts --execute
```
It processes rows in safe batches of 50, and is **safe to stop and re-run**
at any point — it always picks up exactly where it left off (already-done
rows are automatically skipped). If you want to test on one single
document first before running it against everything, add
`--only-id=<a document_deks.id>`.

**Step 5 — confirm it's fully done.**

Re-run the dry-run command from Step 4 — it should now print
`Found 0 document_deks rows not yet on version 2`. That means every
*document* in the system is now locked under the new key.

**Step 5.5 — don't stop there. There's a second, easy-to-miss lockbox.**

`rewrap-deks.ts` only touches the `document_deks` database table. DMS also
has one other file encrypted the exact same way, sitting outside that table
entirely: `.ca-keypair.json` — the private key for DMS's own
internal signing authority (every user's e-signature certificate is issued
from this one CA). It's easy to forget because nothing points you at it.
**If this file is ever left un-rewrapped and an old key version is later
removed, the app doesn't error — it silently generates a brand new CA the
next time it's needed, and every signature ever issued under the old CA
permanently stops verifying, with no warning to anyone.** A dedicated script
handles this one file the same way:
```powershell
node scripts/run-with-env.cjs production tsx scripts/rewrap-ca-keypair.ts            # dry run — confirms it still decrypts
node scripts/run-with-env.cjs production tsx scripts/rewrap-ca-keypair.ts --execute   # rewrap it for real
```
Run this every time you rotate the master key, right after `rewrap-deks.ts`
finishes — treat them as one combined step, not two optional ones.

**Step 6 — do NOT delete the old key yet.**

Even after Step 5 says 0 remaining, keep `VAULT_MASTER_KEY` (the old,
version-1 value) sitting in the env file, and keep a permanent, separate
backup of it. Reasons to keep it around indefinitely: any database backup
taken *before* the rewrap finished still has rows expecting the old key, and
you may need to restore one someday. Removing an old key version should only
ever be a very deliberate, rare decision — not a routine cleanup step — and
only after you're certain no backup you'd ever restore still references it.

---

## 10. Common mistakes to avoid

- **Never overwrite `VAULT_MASTER_KEY`'s value directly.** Always add a new
  numbered version instead (§9, Step 1). Overwriting it is equivalent to
  permanently losing every document that existed before the change.
- **Don't confuse `.env.production` and `.env.prod`.** They're two different
  deployment paths for the same app (native vs. Docker) and can both hold
  real, different, working secrets at once. Rotating the one your server
  isn't actually reading does nothing.
- **`ESIGN_P12_B64`/`ESIGN_P12_PASSPHRASE` are unrelated.** That's a
  certificate used to digitally *sign* completed e-signature ceremonies
  (proving authenticity) — a totally separate mechanism from the
  AES-256-GCM document-at-rest encryption described in this whole guide.
  Losing/rotating it doesn't affect reading any stored document.
- **Don't run `rewrap-deks.ts --execute` without a dry run first** — the
  dry run costs nothing and tells you exactly how many rows are affected
  before you commit to anything.
- **Don't forget `.ca-keypair.json` during a rotation.** It's not in
  the `document_deks` table, `rewrap-deks.ts` never touches it, and losing
  access to it fails *silently* — no error, just a quietly-generated
  replacement CA and every past signature permanently unverifiable from that
  point on. Always run `rewrap-ca-keypair.ts` alongside `rewrap-deks.ts`.
- **Back up before rotating.** A fresh database + storage backup right
  before Step 1 means that even if something goes wrong mid-rotation, you
  have a known-good point to fall back to.

---

## 11. Quick recap

- **Three pieces needed to read any one file:** the `.enc` file, its
  `document_deks` row, and the master key that unlocks that row's key.
- **The master key is irreplaceable** — no backup of the database or files
  helps if it's gone.
- **To rotate the master key without breaking anything:** add it as a new
  numbered version, bump the "current version" pointer, run
  `rewrap-deks.ts --execute`, confirm 0 rows remain, and only then consider
  (very cautiously) ever retiring the old version.
- **To manually decrypt one file:** `dr-decrypt-version.ts <versionId> <outputPath>`.
