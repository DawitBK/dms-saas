/**
 * Report (READ-ONLY): which existing CONFIDENTIAL / RESTRICTED documents the 2026-10-10 classified-document rule closes, and to whom.
 *
 * WHY: until that rule, the classification of an ordinary document was a label, so every member of its department could open it.
 * From now on (shared/classifiedAccess.ts) a CONFIDENTIAL document is open to its owner, people it was deliberately shared with
 * (a per-document grant, including its approval chain, auditors and signers), the head of its department and the oversight roles;
 * a RESTRICTED one is the same without the head. This report lists, per document, who could read it before and who can after, so
 * the owner can review the list BEFORE the rule is deployed to an environment that holds real data.
 *
 * It changes nothing: no row is written. Letter-backed documents are listed separately (they were already participants-only).
 *
 * Usage (from DMS/backend):
 *   npx tsx scripts/report-classified-documents.ts                      # dev, summary per tenant and per department
 *   npx tsx scripts/report-classified-documents.ts --list               # one line per document
 *   npx tsx scripts/report-classified-documents.ts --csv=C:\path\out.csv
 *   npm run report:classified:mirror / :prod                            # through the environment launcher
 */

import 'dotenv/config';
import fs from 'node:fs';
import { QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';

const LIST = process.argv.includes('--list');
const csvArg = process.argv.find((a) => a.startsWith('--csv='));

type Row = {
  id: string;
  tenant_id: string;
  title: string;
  classification: string;
  status: string;
  department: string | null;
  owner_email: string | null;
  members_before: number;
  deliberate_readers: number;
  head_readers: number;
  letter_backed: boolean;
};

async function main() {
  initModels();
  await connectDB();

  // "Before": every current direct member of the document's department (plus the owner) could open it through the department rows.
  // "After": the owner + users holding a deliberate per-document read grant + (CONFIDENTIAL, not a letter's) the department's heads
  // (direct members holding the department:manage permission through any of their roles). Oversight roles are not counted: they read
  // everything before and after.
  const rows = await sequelize.query<Row>(
    `SELECT d.id, d.tenant_id, d.title, d.security_classification AS classification, d.status,
            dep.name AS department, u.email AS owner_email,
            (SELECT count(DISTINCT ud.user_id) FROM user_departments ud WHERE ud.department_id = d.department_id)::int AS members_before,
            (SELECT count(DISTINCT a.principal_id) FROM acl_entries a
              WHERE a.resource_type = 'document' AND a.resource_id = d.id AND a.principal_type = 'user'
                AND a.permission = 'document:read' AND a.effect = 'ALLOW'
                AND (a.origin IS NULL OR a.origin <> 'DEPT_SNAPSHOT') AND (a.expires_at IS NULL OR a.expires_at > now())
                AND a.principal_id <> d.owner_id::text)::int AS deliberate_readers,
            (SELECT count(DISTINCT ud.user_id) FROM user_departments ud
               JOIN user_roles ur ON ur.user_id = ud.user_id
               JOIN roles r ON r.id = ur.role_id AND r.name = 'DEPT_MANAGER'
              WHERE ud.department_id = d.department_id AND d.security_classification = 'CONFIDENTIAL' AND ud.user_id <> d.owner_id)::int AS head_readers,
            EXISTS (SELECT 1 FROM letters l WHERE l.document_id = d.id OR l.signed_draft_document_id = d.id OR l.cover_sheet_document_id = d.id)
              OR EXISTS (SELECT 1 FROM letter_attachments la WHERE la.document_id = d.id) AS letter_backed
       FROM documents d
       LEFT JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.deleted_at IS NULL AND d.security_classification IN ('CONFIDENTIAL', 'RESTRICTED')
      ORDER BY d.tenant_id, dep.name, d.security_classification, d.title`,
    { type: QueryTypes.SELECT },
  );

  const ordinary = rows.filter((r) => !r.letter_backed);
  const letters = rows.filter((r) => r.letter_backed);
  console.log(`\nClassified documents (not in the Recycle Bin): ${rows.length}  (${ordinary.length} ordinary, ${letters.length} belong to letters and are unaffected)\n`);

  const byTenant = new Map<string, Row[]>();
  for (const r of ordinary) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
  if (byTenant.size === 0) console.log('Nothing to review: no ordinary document is CONFIDENTIAL or RESTRICTED.\n');

  for (const [tenant, docs] of byTenant) {
    const byDept = new Map<string, Row[]>();
    for (const d of docs) byDept.set(d.department ?? '(no department)', [...(byDept.get(d.department ?? '(no department)') ?? []), d]);
    console.log(`Tenant ${tenant}: ${docs.length} document(s) will close to the department`);
    for (const [dept, ds] of byDept) {
      const conf = ds.filter((d) => d.classification === 'CONFIDENTIAL').length;
      const restr = ds.length - conf;
      const maxMembers = Math.max(...ds.map((d) => d.members_before));
      console.log(`  ${dept}: ${ds.length} (${conf} Confidential, ${restr} Restricted); up to ${maxMembers} department member(s) could read each before`);
    }
    console.log('');
  }

  if (LIST) {
    console.log('Per document (ordinary documents only):');
    for (const r of ordinary) {
      const after = 1 + r.deliberate_readers + r.head_readers;
      console.log(
        `  [${r.classification.padEnd(12)}] ${r.title}  | ${r.department ?? '-'} | owner ${r.owner_email ?? '-'} | ` +
          `before: ${r.members_before} department member(s) | after: owner + ${r.deliberate_readers} shared + ${r.head_readers} head(s) = ${after}`,
      );
    }
    console.log('');
  }

  if (csvArg) {
    const file = csvArg.slice('--csv='.length);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      'tenant,document_id,title,classification,status,department,owner,letter_backed,department_members_before,shared_readers_after,head_readers_after',
      ...rows.map((r) => [r.tenant_id, r.id, r.title, r.classification, r.status, r.department, r.owner_email, r.letter_backed, r.members_before, r.deliberate_readers, r.head_readers].map(esc).join(',')),
    ];
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    console.log(`Wrote ${rows.length} row(s) to ${file}`);
  }

  console.log('Oversight roles (records officer, executive, auditor, system administrator, platform administrator) read every document before and after.');
  console.log('Nothing was changed.');
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
