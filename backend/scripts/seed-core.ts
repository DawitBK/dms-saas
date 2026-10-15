/**
 * seed-core.ts — Comprehensive encrypted seed for DMS (§0 + §7).
 *
 * Creates reference data, demo users, and REAL encrypted-at-rest documents
 * through the canonical `encryptAndStore()` pipeline. Every seeded document
 * has a genuine `.enc` ciphertext file on disk and a matching `DocumentDek`
 * row, so download/preview/search all exercise the real encryption path.
 *
 * Run AFTER migrations: npm run db:migrate && npm run db:seed:core
 * Safe to re-run (uses findOrCreate / upsert).
 *
 * tenantId = "examplecorp" (matches auth.routes.ts dev token issuer).
 */
import '../src/config/env.js';
import { config } from '../src/config/env.js';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { Document as DocxDocument, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import sharp from 'sharp';
import {
  AclEntry,
  Department,
  Document,
  DocumentDek,
  DocumentLegalHold,
  DocumentMetadata,
  DocumentType,
  DocumentVersion,
  FolderNode,
  LegalHold,
  Notification,
  OrgUnit,
  RetentionPolicy,
  Role,
  SignatureRecord,
  User,
  UserDepartment,
  UserRole,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowTask,
  initModels,
  sequelize,
} from '../src/infrastructure/database/index.js';
import { encryptAndStore } from '../src/modules/documents/documentCrypto.js';
import { grantDefaultDocumentAcl } from '../src/modules/documents/documents.service.js';
import { writeAuditLog } from '../src/modules/audit/audit.service.js';
import { meili, ensureTenantSearchIndex } from '../src/infrastructure/search/meilisearch.js';

const TENANT_ID = 'examplecorp';
const SECOND_TENANT_ID = 'demo-org';

// ─── Reference data ───────────────────────────────────────────────────────────

const ROLES = ['SYSTEM_ADMIN', 'RECORDS_OFFICER', 'DEPT_MANAGER', 'APPROVER', 'EMPLOYEE', 'AUDITOR', 'EXECUTIVE'] as const;

const DEPARTMENTS: [string, string][] = [
  ['FIN', 'Finance'], ['HR', 'Human Resources'], ['PROC', 'Procurement'],
  ['LEG', 'Legal'], ['IT', 'Information Technology'], ['OPS', 'Operations'],
  ['EXEC', 'Executive'], ['AUDIT', 'Audit'],
];

const DOCUMENT_TYPES: { code: string; name: string; retention: string; sig: boolean }[] = [
  { code: 'INVOICE', name: 'Invoice', retention: 'RET-FIN-7Y', sig: false },
  { code: 'CONTRACT', name: 'Contract', retention: 'RET-LEG-10Y', sig: true },
  { code: 'PO', name: 'Purchase Order', retention: 'RET-PROC-7Y', sig: false },
  { code: 'POLICY', name: 'Policy', retention: 'RET-CORP-PERM', sig: false },
  { code: 'EMPLOYEE', name: 'Employee Record', retention: 'RET-HR-7Y', sig: false },
  { code: 'FILING', name: 'Regulatory Filing', retention: 'RET-LEG-10Y', sig: false },
  { code: 'REPORT', name: 'Report', retention: 'RET-CORP-5Y', sig: false },
  { code: 'SOP', name: 'Standard Operating Procedure', retention: 'RET-OPS-5Y', sig: false },
  { code: 'AUDIT', name: 'Audit Report', retention: 'RET-AUDIT-7Y', sig: false },
  { code: 'INCIDENT', name: 'Incident Report', retention: 'RET-OPS-5Y', sig: false },
  { code: 'PLAN', name: 'Strategic Plan', retention: 'RET-CORP-PERM', sig: false },
  { code: 'BOARD', name: 'Board Minutes', retention: 'RET-CORP-PERM', sig: true },
  { code: 'CHANGE', name: 'Change Request', retention: 'RET-IT-3Y', sig: false },
  { code: 'AGREEMENT', name: 'Agreement', retention: 'RET-LEG-10Y', sig: true },
  { code: 'RECEIPT', name: 'Receipt', retention: 'RET-FIN-7Y', sig: false },
];

const RETENTION_POLICIES: { code: string; name: string; years: number | null; permanent: boolean; trigger: string; disposal: string }[] = [
  { code: 'RET-FIN-7Y', name: 'Financial — 7 years', years: 7, permanent: false, trigger: 'TRANSACTION_DATE', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-LEG-10Y', name: 'Legal — 10 years', years: 10, permanent: false, trigger: 'CONTRACT_COMPLETION', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-PROC-7Y', name: 'Procurement — 7 years', years: 7, permanent: false, trigger: 'DOCUMENT_DATE', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-CORP-PERM', name: 'Corporate — Permanent', years: null, permanent: true, trigger: 'DOCUMENT_DATE', disposal: 'PERMANENT_ARCHIVE' },
  { code: 'RET-HR-7Y', name: 'HR — 7 years post-termination', years: 7, permanent: false, trigger: 'EMPLOYEE_TERMINATION', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-CORP-5Y', name: 'Corporate — 5 years', years: 5, permanent: false, trigger: 'DOCUMENT_DATE', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-OPS-5Y', name: 'Operations — 5 years', years: 5, permanent: false, trigger: 'DOCUMENT_DATE', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-AUDIT-7Y', name: 'Audit — 7 years', years: 7, permanent: false, trigger: 'AUDIT_COMPLETION', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-IT-3Y', name: 'IT — 3 years', years: 3, permanent: false, trigger: 'DOCUMENT_DATE', disposal: 'CERTIFIED_DELETION' },
  { code: 'RET-LEGAL-HOLD', name: 'Legal Hold — Permanent', years: null, permanent: true, trigger: 'DOCUMENT_DATE', disposal: 'PERMANENT_ARCHIVE' },
  { code: 'RET-OPS-PERM-ACTIVE', name: 'Operations — Permanent (Active)', years: null, permanent: true, trigger: 'DOCUMENT_DATE', disposal: 'PERMANENT_ARCHIVE' },
];

const DEMO_USERS: { email: string; firstName: string; lastName: string; role: string; dept: string }[] = [
  { email: 'admin@edams.local', firstName: 'System', lastName: 'Admin', role: 'SYSTEM_ADMIN', dept: 'FIN' },
  { email: 'manager@edams.local', firstName: 'Dept', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'FIN' },
  { email: 'officer@edams.local', firstName: 'Records', lastName: 'Officer', role: 'RECORDS_OFFICER', dept: 'FIN' },
  { email: 'approver@edams.local', firstName: 'Document', lastName: 'Approver', role: 'APPROVER', dept: 'FIN' },
  { email: 'employee@edams.local', firstName: 'Staff', lastName: 'Employee', role: 'EMPLOYEE', dept: 'FIN' },
  { email: 'auditor@edams.local', firstName: 'System', lastName: 'Auditor', role: 'AUDITOR', dept: 'AUDIT' },
  // Department-scoped users for broader coverage
  { email: 'hr.manager@edams.local', firstName: 'HR', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'HR' },
  { email: 'proc.manager@edams.local', firstName: 'Procurement', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'PROC' },
  { email: 'it.officer@edams.local', firstName: 'IT', lastName: 'Officer', role: 'RECORDS_OFFICER', dept: 'IT' },
  { email: 'legal.approver@edams.local', firstName: 'Legal', lastName: 'Approver', role: 'APPROVER', dept: 'LEG' },
  { email: 'ops.employee@edams.local', firstName: 'Ops', lastName: 'Staff', role: 'EMPLOYEE', dept: 'OPS' },
  { email: 'exec.manager@edams.local', firstName: 'Executive', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'EXEC' },
  // IT/Legal/Operations/Audit previously had no DEPT_MANAGER member at all —
  // approvals.service.ts's assertStepIsActionable refuses to create any chain
  // whose "Manager Approval" (assignedRole: DEPT_MANAGER) step would be
  // unstaffed for the item's own department (by design, so no chain is ever
  // created that nobody can decide), so submitting ANY document in these four
  // departments failed with ERR-STEP-ROLE-UNSTAFFED. Filling the same gap
  // FIN/HR/PROC/EXEC already had covered.
  { email: 'it.manager@edams.local', firstName: 'IT', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'IT' },
  { email: 'legal.manager@edams.local', firstName: 'Legal', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'LEG' },
  { email: 'ops.manager@edams.local', firstName: 'Operations', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'OPS' },
  { email: 'audit.manager@edams.local', firstName: 'Audit', lastName: 'Manager', role: 'DEPT_MANAGER', dept: 'AUDIT' },
  // Standing correspondence oversight recipient — CAMS letter notification emails (chief-level).
  { email: 'chief@edams.local', firstName: 'Chief', lastName: 'Executive', role: 'EXECUTIVE', dept: 'EXEC' },
];

const DEPT_CATEGORIES: Record<string, string[]> = {
  Finance: ['Invoices', 'Contracts', 'Purchase Orders', 'Financial Reports'],
  'Human Resources': ['Employee Records', 'Policies & Procedures', 'Payroll'],
  Procurement: ['Purchase Orders', 'Supplier Contracts', 'Quotations'],
  Legal: ['Contracts', 'Regulatory Filings', 'Compliance Documents'],
  'Information Technology': ['System Documentation', 'Change Requests', 'SOPs'],
  Operations: ['Operational Reports', 'SOPs', 'Incident Reports'],
  Executive: ['Board Minutes', 'Strategic Plans'],
  Audit: ['Audit Reports', 'Compliance Reports'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsert<T extends { id: string }>(Model: any, where: Record<string, unknown>, defaults: Record<string, unknown>): Promise<T> {
  const [row] = await Model.findOrCreate({ where, defaults: { ...where, ...defaults } });
  return row as T;
}

async function makePdf(opts: { title: string; body: string }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(opts.title, { x: 50, y: 720, size: 18, font, color: rgb(0.1, 0.1, 0.3) });
  page.drawText(opts.body, { x: 50, y: 680, size: 11, font, maxWidth: 500 });
  return { buffer: Buffer.from(await pdf.save()), extractedText: `${opts.title}\n${opts.body}` };
}

async function makeExcel(opts: { title: string; data: string[][] }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(opts.title);
  sheet.addRow([opts.title]);
  for (const row of opts.data) sheet.addRow(row);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, extractedText: `${opts.title}\n${opts.data.map(r => r.join(' ')).join('\n')}` };
}

async function makeDocx(opts: { title: string; body: string }) {
  const doc = new DocxDocument({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: opts.title, heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }),
        new Paragraph({ children: [new TextRun({ text: opts.body, size: 24 })], spacing: { after: 200 } }),
        new Paragraph({ children: [new TextRun({ text: `Document generated on ${new Date().toISOString()}`, size: 20, color: '666666' })] }),
      ],
    }],
  });
  return { buffer: Buffer.from(await Packer.toBuffer(doc)), extractedText: `${opts.title}\n${opts.body}` };
}

async function makeImage(opts: { title: string; color: string }) {
  const svg = `<svg width="800" height="600"><rect width="800" height="600" fill="${opts.color}"/><text x="400" y="300" font-family="Arial" font-size="24" fill="white" text-anchor="middle">${opts.title}</text></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, extractedText: `Image: ${opts.title}` };
}

function docName(dept: string, type: string, i: number) {
  const d = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${dept}-${type}-${d}-${String(i + 1).padStart(4, '0')}`;
}

// ─── Document seed plan ───────────────────────────────────────────────────────
// Covers every department, every document type, and every status.

interface SeedDoc {
  title: string;
  deptCode: string;
  typeCode: string;
  status: string;
  ownerEmail: string;
  retCode: string;
  folder: string;
  isLegalHold?: boolean;
  signatureStatus?: 'PENDING' | 'SIGNED' | 'DECLINED';
}

function buildSeedDocs(): SeedDoc[] {
  const docs: SeedDoc[] = [];
  const statuses = ['DRAFT', 'IN_REVIEW', 'ACTIVE', 'ARCHIVED'];
  let idx = 0;

  // Ensure every department × every document type has at least one doc
  for (const [deptCode, deptName] of DEPARTMENTS) {
    const cats = DEPT_CATEGORIES[deptName] ?? ['General'];
    for (const dt of DOCUMENT_TYPES) {
      const status = statuses[idx % statuses.length];
      const cat = cats[idx % cats.length];
      const ownerEmail = deptCode === 'AUDIT' ? 'auditor@edams.local'
        : deptCode === 'HR' ? 'hr.manager@edams.local'
        : deptCode === 'PROC' ? 'proc.manager@edams.local'
        : deptCode === 'IT' ? 'it.officer@edams.local'
        : deptCode === 'LEG' ? 'legal.approver@edams.local'
        : deptCode === 'OPS' ? 'ops.employee@edams.local'
        : deptCode === 'EXEC' ? 'exec.manager@edams.local'
        : 'officer@edams.local';
      docs.push({
        title: `${dt.name} — ${deptName}`,
        deptCode,
        typeCode: dt.code,
        status,
        ownerEmail,
        retCode: dt.retention,
        folder: `/Example Corp/${deptName}/${cat}`,
      });
      idx++;
    }
  }

  // Add specific status coverage
  // Legal hold document
  docs.push({ title: 'Q4 2025 Financial Investigation', deptCode: 'FIN', typeCode: 'REPORT', status: 'ACTIVE', ownerEmail: 'admin@edams.local', retCode: 'RET-LEGAL-HOLD', folder: '/Example Corp/Finance/Financial Reports', isLegalHold: true });
  // E-signed documents
  docs.push({ title: 'Vendor Master Service Agreement', deptCode: 'LEG', typeCode: 'AGREEMENT', status: 'ACTIVE', ownerEmail: 'legal.approver@edams.local', retCode: 'RET-LEG-10Y', folder: '/Example Corp/Legal/Contracts', signatureStatus: 'SIGNED' });
  docs.push({ title: 'Office Lease Renewal Contract', deptCode: 'EXEC', typeCode: 'CONTRACT', status: 'IN_REVIEW', ownerEmail: 'exec.manager@edams.local', retCode: 'RET-LEG-10Y', folder: '/Example Corp/Executive/Board Minutes', signatureStatus: 'PENDING' });
  docs.push({ title: 'Software License Agreement — Declined', deptCode: 'IT', typeCode: 'AGREEMENT', status: 'DRAFT', ownerEmail: 'it.officer@edams.local', retCode: 'RET-LEG-10Y', folder: '/Example Corp/Information Technology/System Documentation', signatureStatus: 'DECLINED' });
  // DISPOSAL_PENDING
  docs.push({ title: 'Expired Vendor Quotation 2023', deptCode: 'PROC', typeCode: 'PO', status: 'ARCHIVED', ownerEmail: 'proc.manager@edams.local', retCode: 'RET-PROC-7Y', folder: '/Example Corp/Procurement/Purchase Orders' });

  return docs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // DEMO data: 13+ hardcoded @edams.local accounts, a second fake "demo-org" tenant and encrypted
  // demo documents, alongside the reference data a fresh database needs. It must never reach
  // production or the production-parity mirror by accident: `npm run db:seed:core:prod` reads
  // like a setup command and would otherwise just run. (This guard was removed 2026-07-31 so
  // demo accounts could sign in on the live box; that need ended 2026-10-04 with SSO-only
  // sign-in, and the demo data is cleaned out by scripts/cleanup-seed-data.ts.)
  //
  // Use `npm run db:seed:reference:prod` for reference data only. To seed demo data into a
  // non-development database anyway, name that database: I_UNDERSTAND_THIS_SEEDS_DEMO_DATA=<db>.
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'mirror') {
    const dbName = String(config.DB_NAME);
    if (process.env.I_UNDERSTAND_THIS_SEEDS_DEMO_DATA !== dbName) {
      console.error(`\nRefusing to seed DEMO data into "${dbName}" (NODE_ENV=${process.env.NODE_ENV}).`);
      console.error('Use `npm run db:seed:reference:prod` (or :mirror) for reference data only.');
      console.error(`If you really mean it: I_UNDERSTAND_THIS_SEEDS_DEMO_DATA=${dbName}\n`);
      process.exit(2);
    }
    console.warn(`⚠️  Seeding DEMO data into ${dbName} on explicit request.`);
  }
  console.log('Connecting…');
  initModels();
  await sequelize.authenticate();
  console.log('Connected to', sequelize.config.database);

  // 0. Tenants (v3 §2)
  console.log('Seeding tenants…');
  const { Tenant, UserTenant } = await import('../src/infrastructure/database/index.js');
  const TENANT_NAME = 'Example Corp';
  await upsert(Tenant, { id: TENANT_ID }, { name: TENANT_NAME, isActive: true, storageQuotaBytes: 10 * 1024 * 1024 * 1024, maxUsers: 100, maxDocuments: 10000 });
  await upsert(Tenant, { id: SECOND_TENANT_ID }, { name: 'Demo Organization', isActive: true, storageQuotaBytes: 5 * 1024 * 1024 * 1024, maxUsers: 50, maxDocuments: 5000 });

  // FIX 2026-09-14: every table this script writes below (org_units,
  // departments, document_types, folder_nodes, users, documents, workflow_*,
  // audit_logs, access_rules, notifications) has forced RLS keyed on
  // `app.current_tenant` (see requestContext.ts / workerTenantContext.ts —
  // this is the same GUC HTTP requests and workers set per-tenant). This
  // script had never set it, so it only ever worked against a superuser DB
  // role (dev's DB_USER=postgres, which bypasses RLS) and silently failed —
  // "HQ org unit missing", or an invisible/unwritable table — the moment it
  // ran as a real app role (edams_app, what mirror's and real prod's
  // DB_USER actually is). All demo content below belongs to TENANT_ID, so one
  // session-wide SET (not per-transaction SET LOCAL — this script is a single
  // sequential process, not concurrent request handlers) covers the whole
  // run; SECOND_TENANT_ID only ever gets a user_tenants row, and that table
  // has no RLS.
  await sequelize.query('SET app.current_tenant = :tenantId', { replacements: { tenantId: TENANT_ID } });

  // 1. Roles
  console.log('Seeding roles…');
  for (const name of ROLES) await upsert(Role, { name }, { description: `${name} system role` });

  // 1b. Organizational units — CAMS org units, now also the parent of departments.
  // HQ is auto-created per tenant by the CAMS foundation + org-unit migrations;
  // add one more unit here so the demo data shows multiple units under one tenant.
  console.log('Seeding organizational units…');
  const hqUnit = await OrgUnit.findOne({ where: { tenantId: TENANT_ID, code: 'HQ' } });
  if (!hqUnit) throw new Error('HQ org unit missing for tenant — run `npm run db:migrate` first');
  const regionalUnit = await upsert<OrgUnit>(OrgUnit, { tenantId: TENANT_ID, code: 'REG-WEST' }, { name: 'Regional Office — West', unitType: 'BRANCH' });

  // 2. Departments — most sit under HQ; AUDIT sits under the regional unit so
  // the hierarchy browser demonstrably shows two org units, each with its own
  // department/folder structure beneath it.
  console.log('Seeding departments…');
  const DEPT_ORG_UNIT: Record<string, string> = { AUDIT: regionalUnit.id };
  for (const [code, name] of DEPARTMENTS) {
    const orgUnitId = DEPT_ORG_UNIT[code] ?? hqUnit.id;
    await upsert(Department, { tenantId: TENANT_ID, code }, { name, isActive: true, orgUnitId });
  }

  // 3. Document types
  console.log('Seeding document types…');
  for (const t of DOCUMENT_TYPES) {
    await upsert(DocumentType, { tenantId: TENANT_ID, code: t.code }, { name: t.name, defaultRetentionClass: t.retention, requiresSignature: t.sig, isActive: true });
  }

  // 4. Retention policies
  console.log('Seeding retention policies…');
  for (const p of RETENTION_POLICIES) {
    await upsert(RetentionPolicy, { code: p.code }, { name: p.name, retentionYears: p.years, isPermanent: p.permanent, triggerEvent: p.trigger, disposalAction: p.disposal, authority: 'DMS Phase 1 Governance Policy', isActive: true });
  }

  // 5. Folder hierarchy — one folder per org unit beneath the root, each
  // department's folder nests under ITS OWN org unit's folder (mirrors
  // folders.service.ts's getOrCreateOrgUnitFolder) instead of every
  // department across every org unit sharing one "Example Corp" folder
  // regardless of which org unit it actually belongs to. Root is named after
  // the TENANT (matches getOrCreateTenantRootFolder) since it's the top of
  // Tenant -> OrgUnit -> Department -> FolderNode -- naming it after the
  // tenant, not a generic product placeholder, is what makes the tree read
  // as "the tenant, then its org units" rather than a same-named org unit
  // sitting as a sibling to the real ones.
  console.log('Seeding folder tree…');
  const root = await upsert<FolderNode>(FolderNode, { tenantId: TENANT_ID, path: '/' }, { name: TENANT_NAME, level: 0, parentId: null, departmentId: null, orgUnitId: null, isSystemManaged: true });
  const orgUnitFolders = new Map<string, FolderNode>();
  async function getOrgUnitFolder(unit: OrgUnit): Promise<FolderNode> {
    const cached = orgUnitFolders.get(unit.id);
    if (cached) return cached;
    const slug = unit.code.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || unit.id;
    const folder = await upsert<FolderNode>(FolderNode, { tenantId: TENANT_ID, path: `/${slug}` }, { name: unit.name, level: 1, parentId: root.id, departmentId: null, orgUnitId: unit.id, isSystemManaged: true });
    orgUnitFolders.set(unit.id, folder);
    return folder;
  }
  for (const [code, name] of DEPARTMENTS) {
    const dept = await Department.findOne({ where: { tenantId: TENANT_ID, code } });
    if (!dept) continue;
    const unit = dept.orgUnitId === regionalUnit.id ? regionalUnit : hqUnit;
    const org = await getOrgUnitFolder(unit);
    const deptPath = `${org.path}/${name}`;
    const deptFolder = await upsert<FolderNode>(FolderNode, { tenantId: TENANT_ID, path: deptPath }, { name, level: 2, parentId: org.id, departmentId: dept.id, orgUnitId: unit.id, isSystemManaged: true });
    for (const cat of DEPT_CATEGORIES[name] ?? []) {
      await upsert(FolderNode, { tenantId: TENANT_ID, path: `${deptPath}/${cat}` }, { name: cat, level: 3, parentId: deptFolder.id, departmentId: dept.id, orgUnitId: unit.id, isSystemManaged: true });
    }
  }

  // 6. Workflow definition
  console.log('Seeding default workflow…');
  await upsert(WorkflowDefinition, { id: '00000000-0000-0000-0000-000000000001' }, {
    tenantId: TENANT_ID, name: 'Standard 3-Stage Approval', version: '1.0', isActive: true, isDefault: true,
    definition: JSON.stringify({
      stages: [
        { stageNumber: 1, name: 'Records Review', assignedRole: 'RECORDS_OFFICER', slaDurationHours: 24, slaBusinessHoursOnly: true },
        { stageNumber: 2, name: 'Manager Approval', assignedRole: 'DEPT_MANAGER', slaDurationHours: 48, slaBusinessHoursOnly: true },
        { stageNumber: 3, name: 'Final Approval', assignedRole: 'APPROVER', slaDurationHours: 24, slaBusinessHoursOnly: true },
      ],
    }),
  });

  // 7. Demo users
  console.log('Seeding demo users…');
  const userMap: Record<string, any> = {};
  for (const u of DEMO_USERS) {
    const role = await Role.findOne({ where: { name: u.role } });
    const dept = await Department.findOne({ where: { tenantId: TENANT_ID, code: u.dept } });
    if (!role || !dept) { console.warn(`  Skipping ${u.email}`); continue; }
    const [user] = await User.findOrCreate({ where: { email: u.email }, defaults: { email: u.email, firstName: u.firstName, lastName: u.lastName, isActive: true, passwordHash: null } });
    await UserRole.findOrCreate({ where: { userId: user.id, roleId: role.id }, defaults: { userId: user.id, roleId: role.id } });
    await UserDepartment.findOrCreate({ where: { userId: user.id, departmentId: dept.id }, defaults: { userId: user.id, departmentId: dept.id } });
    userMap[u.email] = user;
    console.log(`  ✓ ${u.email}  (${u.role})`);
  }

  const admin = userMap['admin@edams.local'];
  if (!admin) throw new Error('Admin user missing');

  // 7b. Assign tenant memberships (v3 §2)
  console.log('Seeding tenant memberships…');
  // Assign admin to both tenants (so they can test tenant switcher)
  await UserTenant.findOrCreate({
    where: { userId: admin.id, tenantId: TENANT_ID },
    defaults: { userId: admin.id, tenantId: TENANT_ID, assignedBy: admin.id }
  });
  await UserTenant.findOrCreate({
    where: { userId: admin.id, tenantId: SECOND_TENANT_ID },
    defaults: { userId: admin.id, tenantId: SECOND_TENANT_ID, assignedBy: admin.id }
  });
  console.log(`  ✓ admin@edams.local assigned to both tenants`);
  
  // Assign all other users to primary tenant only
  for (const u of DEMO_USERS) {
    if (u.email === 'admin@edams.local') continue;
    const user = userMap[u.email];
    if (!user) continue;
    await UserTenant.findOrCreate({
      where: { userId: user.id, tenantId: TENANT_ID },
      defaults: { userId: user.id, tenantId: TENANT_ID, assignedBy: admin.id }
    });
  }
  console.log(`  ✓ All other users assigned to ${TENANT_ID}`);

  // 8. Encrypted documents through canonical pipeline
  console.log('Seeding encrypted documents…');
  const deptMap: Record<string, any> = {};
  for (const [code] of DEPARTMENTS) deptMap[code] = await Department.findOne({ where: { tenantId: TENANT_ID, code } });
  const docTypeMap: Record<string, any> = {};
  for (const dt of DOCUMENT_TYPES) docTypeMap[dt.code] = await DocumentType.findOne({ where: { tenantId: TENANT_ID, code: dt.code } });
  const retentionMap: Record<string, any> = {};
  for (const rp of RETENTION_POLICIES) retentionMap[rp.code] = await RetentionPolicy.findOne({ where: { code: rp.code } });
  const folderMap: Record<string, string> = {};
  const folders = await FolderNode.findAll({ where: { tenantId: TENANT_ID, level: 3 } });
  for (const f of folders) folderMap[f.path] = f.id;

  const seedDocs = buildSeedDocs();
  let docCount = 0;
  const createdDocs: any[] = [];

  for (const sd of seedDocs) {
    const dept = deptMap[sd.deptCode];
    const owner = userMap[sd.ownerEmail] ?? admin;
    const docType = docTypeMap[sd.typeCode];
    if (!dept || !docType) { console.warn(`  ⚠️  Skipping "${sd.title}" — missing dept/type`); continue; }

    // Check if already exists (idempotency)
    const existing = await Document.findOne({ where: { title: sd.title, departmentId: dept.id } });
    if (existing) {
      console.log(`  ⊘ "${sd.title}" already exists, skipping`);
      createdDocs.push(existing);
      continue;
    }

    // Generate file content in-memory
    let buffer: Buffer; let extractedText: string; let mimeType: string; let extension: string;
    const name = docName(sd.deptCode, sd.typeCode, docCount);

    if (sd.typeCode === 'INVOICE' || sd.typeCode === 'RECEIPT' || sd.typeCode === 'REPORT') {
      const result = await makeExcel({ title: sd.title, data: [['Date', 'Description', 'Amount', 'Status'], [new Date().toISOString().split('T')[0], `Item for ${dept.name}`, '$1,250.00', sd.status], [new Date().toISOString().split('T')[0], 'Another item', '$3,500.00', sd.status]] });
      buffer = result.buffer; extractedText = result.extractedText;
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; extension = 'xlsx';
    } else if (sd.typeCode === 'POLICY' || sd.typeCode === 'SOP' || sd.typeCode === 'CONTRACT' || sd.typeCode === 'AGREEMENT' || sd.typeCode === 'BOARD') {
      const result = await makeDocx({ title: sd.title, body: `This is a sample ${docType.name.toLowerCase()} for ${dept.name}.\n\nStatus: ${sd.status}\n\nThis document contains important information related to ${dept.name} operations.` });
      buffer = result.buffer; extractedText = result.extractedText;
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; extension = 'docx';
    } else if (sd.typeCode === 'AUDIT') {
      const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444'];
      const result = await makeImage({ title: sd.title, color: colors[docCount % colors.length] });
      buffer = result.buffer; extractedText = result.extractedText;
      mimeType = 'image/png'; extension = 'png';
    } else {
      const result = await makePdf({ title: sd.title, body: `Sample ${docType.name} for ${dept.name}. Status: ${sd.status}.` });
      buffer = result.buffer; extractedText = result.extractedText;
      mimeType = 'application/pdf'; extension = 'pdf';
    }

    // §0 FIX: Use canonical encryptAndStore — writes .enc ciphertext + generates DEK
    const storageKey = `${sd.deptCode}/${sd.typeCode}/${name}.${extension}`;
    const { encryptedKey, sha256Hash, kekId } = await encryptAndStore(storageKey, buffer, mimeType, dept.id, TENANT_ID);

    const folderId = folderMap[sd.folder] ?? null;

    const document = await Document.create({
      tenantId: TENANT_ID,
      documentName: name,
      title: sd.title,
      departmentId: dept.id,
      documentTypeId: docType.id,
      folderId,
      ownerId: owner.id,
      organisationUnit: 'Example Corp',
      status: sd.status,
      approvalStatus: sd.status === 'IN_REVIEW' ? 'IN_PROGRESS' : 'NOT_REQUIRED',
      securityClassification: 'INTERNAL',
      retentionClass: retentionMap[sd.retCode]?.code ?? docType.defaultRetentionClass,
      isOnLegalHold: sd.isLegalHold ?? false,
      source: 'SEED',
      currentVersion: '1.0',
    });

    await DocumentMetadata.create({
      documentId: document.id,
      keywords: `${sd.deptCode},${sd.typeCode},demo`,
      description: `Demo ${docType.name} for ${dept.name}`,
      tags: JSON.stringify(['demo', sd.deptCode.toLowerCase(), sd.typeCode.toLowerCase()]),
    });

    const version = await DocumentVersion.create({
      documentId: document.id,
      versionNumber: '1.0',
      isMajorVersion: true,
      storageKey,
      storageBucket: 'dms-documents',
      fileSize: BigInt(buffer.length),
      mimeType,
      originalFilename: `${name}.${extension}`,
      sha256Hash,
      extractedText,
      authorId: owner.id,
      changeSummary: 'Seed upload (encrypted)',
    });

    // Persist the DEK row, keyed by versionId (required by fetchAndDecrypt)
    await DocumentDek.create({ documentId: document.id, versionId: version.id, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' });
    await document.update({ latestVersionId: version.id });

    // ACL entries — allow all non-admin roles to read (admin bypasses via §6 fix)
    // Read access follows the document's department membership and owner,
    // exactly like a real upload. Never seed a role-wide document:read ACL:
    // role principals have no department dimension and would make every holder
    // of that role a tenant-wide reader.
    await grantDefaultDocumentAcl(document.id, owner.id, TENANT_ID, dept.id);

    // Audit log for document creation
    try {
      await writeAuditLog({
        eventType: 'DOCUMENT_CREATED',
        userId: owner.id,
        userRole: owner.email === 'admin@edams.local' ? 'SYSTEM_ADMIN' : 'RECORDS_OFFICER',
        documentId: document.id,
        actionDetails: { title: sd.title, department: sd.deptCode, type: sd.typeCode, status: sd.status, encrypted: true },
        isSuccess: true,
      });
    } catch (err: any) {
      if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
    }

    createdDocs.push(document);
    docCount++;
    console.log(`  ✅ "${sd.title}" [${sd.status}] → ${storageKey}.enc`);
  }

  // 9. Workflow instances for IN_REVIEW documents
  // Stage order matches WorkflowDefinition '00000000-0000-0000-0000-000000000001':
  //   Stage 1 → "Records Review"   → assignedToRole: RECORDS_OFFICER  (SLA 24h)
  //   Stage 2 → "Manager Approval" → assignedToRole: DEPT_MANAGER      (SLA 48h)
  //   Stage 3 → "Final Approval"   → assignedToRole: APPROVER          (SLA 24h)
  // Documents are spread 3 ways (by docIndex % 3) so each of the three
  // approver-capable seeded roles has at least one PENDING task to act on —
  // otherwise the seeded `approver@edams.local` user never has anything to do.
  console.log('Seeding workflow instances…');
  const inReviewDocs = createdDocs.filter(d => d.status === 'IN_REVIEW');
  const wfDef = await WorkflowDefinition.findByPk('00000000-0000-0000-0000-000000000001');

  async function createTask(
    wfInstanceId: string,
    stageNumber: number,
    stageName: string,
    assignedRole: string,
    slaHours: number,
    status: 'PENDING' | 'APPROVED',
  ) {
    const [task, created] = await WorkflowTask.findOrCreate({
      where: { workflowInstanceId: wfInstanceId, stageNumber },
      defaults: {
        tenantId: TENANT_ID,
        workflowInstanceId: wfInstanceId,
        stageName,
        stageNumber,
        assignedToRole: assignedRole,
        status,
        ...(status === 'APPROVED' ? {
          decision: 'APPROVED' as const,
          decisionReason: 'Seed: pre-approved for demo',
          decidedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        } : {}),
        slaDeadlineAt: new Date(Date.now() + slaHours * 60 * 60 * 1000),
        slaWarningAt: new Date(Date.now() + (slaHours * 0.75) * 60 * 60 * 1000),
      },
    });
    if (created) {
      await AclEntry.findOrCreate({
        where: { resourceType: 'workflow_task', resourceId: task.id, principalType: 'role', principalId: assignedRole, permission: 'WRITE' },
        defaults: { tenantId: TENANT_ID, resourceType: 'workflow_task', resourceId: task.id, principalType: 'role', principalId: assignedRole, effect: 'ALLOW', permission: 'WRITE', grantedById: admin.id },
      });
    }
    return task;
  }

  for (const doc of inReviewDocs) {
    if (!wfDef) break;
    const docIndex = inReviewDocs.indexOf(doc);
    const bucket = docIndex % 3;

    const [wfInstance] = await WorkflowInstance.findOrCreate({
      where: { documentId: doc.id },
      defaults: {
        tenantId: TENANT_ID,
        documentId: doc.id,
        workflowDefinitionId: wfDef.id,
        status: 'ACTIVE',
        initiatedById: doc.ownerId,
        currentStage: 1,
      },
    });

    if (bucket === 0) {
      // Awaiting RECORDS_OFFICER at stage 1.
      await createTask(wfInstance.id, 1, 'Records Review', 'RECORDS_OFFICER', 24, 'PENDING');
    } else if (bucket === 1) {
      // Stage 1 already approved — awaiting DEPT_MANAGER at stage 2.
      await createTask(wfInstance.id, 1, 'Records Review', 'RECORDS_OFFICER', 24, 'APPROVED');
      await createTask(wfInstance.id, 2, 'Manager Approval', 'DEPT_MANAGER', 48, 'PENDING');
      await wfInstance.update({ currentStage: 2 });
    } else {
      // Stages 1-2 already approved — awaiting APPROVER at stage 3.
      await createTask(wfInstance.id, 1, 'Records Review', 'RECORDS_OFFICER', 24, 'APPROVED');
      await createTask(wfInstance.id, 2, 'Manager Approval', 'DEPT_MANAGER', 48, 'APPROVED');
      await createTask(wfInstance.id, 3, 'Final Approval', 'APPROVER', 24, 'PENDING');
      await wfInstance.update({ currentStage: 3 });
    }
  }

  // 10. Legal holds
  console.log('Seeding legal holds…');
  const lhDocs = createdDocs.filter(d => d.isOnLegalHold);
  if (lhDocs.length > 0) {
    const [lh] = await LegalHold.findOrCreate({
      where: { caseReference: 'LH-2026-001' },
      defaults: { tenantId: TENANT_ID, caseReference: 'LH-2026-001', description: 'Financial investigation Q4 2025', custodianName: 'Legal Department', legalBasis: 'Court Order 2026-CV-0042', expectedDuration: '6 months', status: 'ACTIVE', appliedById: admin.id },
    });
    for (const doc of lhDocs) {
      await DocumentLegalHold.findOrCreate({ where: { documentId: doc.id, legalHoldId: lh.id }, defaults: { documentId: doc.id, legalHoldId: lh.id } });
      await doc.update({ isOnLegalHold: true });
    }
    try {
      await writeAuditLog({ eventType: 'LEGAL_HOLD_PLACED', userId: admin.id, userRole: 'SYSTEM_ADMIN', documentId: lhDocs[0]?.id, actionDetails: { caseReference: 'LH-2026-001', documentsAffected: lhDocs.length }, isSuccess: true });
    } catch (err: any) {
      if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
    }
  }

  // 11. E-signature records
  console.log('Seeding signature records…');
  const sigDocs = seedDocs.filter(s => s.signatureStatus);
  for (const sd of sigDocs) {
    const doc = createdDocs.find(d => d.title === sd.title);
    if (!doc) continue;
    const signatory = userMap[sd.ownerEmail] ?? admin;
    const version = await DocumentVersion.findOne({ where: { documentId: doc.id } });
    await SignatureRecord.findOrCreate({
      where: { documentId: doc.id, signatoryUserId: signatory.id },
      defaults: {
        documentId: doc.id,
        documentVersionId: version?.id ?? null,
        signatoryUserId: signatory.id,
        signingType: 'PKCS7',
        status: sd.signatureStatus!,
        signatureAlgorithm: 'RSA-256',
        documentHashAtSign: crypto.createHash('sha256').update(sd.title).digest('hex'),
        signatureData: sd.signatureStatus === 'SIGNED' ? 'mock-signature-base64-data' : null,
        ipAddress: '127.0.0.1',
        userAgent: 'DMS-Seed/1.0',
        consentAcknowledged: true,
      },
    });
    if (sd.signatureStatus === 'SIGNED') {
      try {
        await writeAuditLog({ eventType: 'DOCUMENT_SIGNED', userId: signatory.id, userRole: 'APPROVER', documentId: doc.id, actionDetails: { signingType: 'PKCS7', status: 'SIGNED' }, isSuccess: true });
      } catch (err: any) {
        if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
      }
    }
  }

  // 12. Notifications
  console.log('Seeding notifications…');
  const allUsers = await User.findAll();
  for (const user of allUsers) {
    await Notification.findOrCreate({ where: { userId: user.id, type: 'WELCOME', title: 'Welcome to DMS' }, defaults: { userId: user.id, type: 'WELCOME', title: 'Welcome to DMS', body: 'Your document management workspace is ready.' } });
    await Notification.findOrCreate({ where: { userId: user.id, type: 'TASK', title: 'Documents seeded' }, defaults: { userId: user.id, type: 'TASK', title: 'Documents seeded', body: `${docCount} encrypted documents are available in the repository.` } });
  }

  // 13. Additional audit log entries for realism
  console.log('Seeding audit trail…');
  const sampleDocsForAudit = createdDocs.slice(0, Math.min(10, createdDocs.length));
  for (const doc of sampleDocsForAudit) {
    try {
      await writeAuditLog({ eventType: 'DOCUMENT_DOWNLOADED', userId: admin.id, userRole: 'SYSTEM_ADMIN', documentId: doc.id, actionDetails: { filename: doc.documentName }, isSuccess: true });
    } catch (err: any) {
      if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
    }
  }
  try {
    await writeAuditLog({ eventType: 'SYSTEM_SEED', userId: admin.id, userRole: 'SYSTEM_ADMIN', actionDetails: { documentsCreated: docCount, users: allUsers.length, encrypted: true }, isSuccess: true });
  } catch (err: any) {
    if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
  }

  // 14. Index to Meilisearch (§4 fix)
  if (meili) {
    console.log('Indexing documents to Meilisearch…');
    try {
      await ensureTenantSearchIndex(TENANT_ID);
      const index = meili.index(`edms-docs-${TENANT_ID}`);
      const meiliDocs: any[] = [];
      for (const doc of createdDocs) {
        const fullDoc = await Document.findByPk(doc.id, {
          include: [
            { model: Department, as: 'department' },
            { model: DocumentType, as: 'documentType' },
            { model: DocumentMetadata, as: 'metadata', required: false },
          ],
        });
        if (!fullDoc) continue;
        const p = fullDoc.get({ plain: true }) as any;
        meiliDocs.push({
          id: p.id,
          tenantId: TENANT_ID,
          documentName: p.documentName,
          title: p.title,
          departmentCode: p.department?.code,
          documentTypeCode: p.documentType?.code,
          status: p.status,
          securityClassification: p.securityClassification,
          retentionClass: p.retentionClass,
          isOnLegalHold: p.isOnLegalHold,
          ownerId: p.ownerId,
          organisationUnit: p.organisationUnit,
          keywords: p.metadata?.keywords ?? '',
          description: p.metadata?.description ?? '',
          extractedText: p.metadata?.extractedText ?? '',
          createdAt: p.createdAt?.toISOString?.() ?? p.createdAt,
          updatedAt: p.updatedAt?.toISOString?.() ?? p.updatedAt,
        });
      }
      if (meiliDocs.length > 0) {
        await index.addDocuments(meiliDocs);
        console.log(`  ✅ Indexed ${meiliDocs.length} documents to edms-docs-${TENANT_ID}`);
      }
    } catch (err) {
      console.warn(`  ⚠️  Meilisearch indexing failed: ${err}`);
    }
  } else {
    console.log('  ⊘ Meilisearch not configured — skipping search index');
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`Seed complete: ${docCount} encrypted documents, ${allUsers.length} users`);
  console.log('Demo accounts (passwordless dev mode):');
  for (const u of DEMO_USERS) {
    console.log(`  ${u.email.padEnd(30)} → ${u.role}`);
  }
  console.log('\nLogin at http://localhost:7101 — enter email only.');
  console.log('═══════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
