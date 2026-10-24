/**
 * seed-qa-world.ts — a complete QA tenant for trying out and testing EVERYTHING in DMS (dev only).
 *
 * It builds, through the same services the screens use, a separate tenant `qa-lab` ("QA Laboratory") that
 * is kept apart from the real collected data and from the demo tenant:
 *
 *   structure   4 organisation units (HQ, branch, outlet, sister company), departments, sub-departments (two
 *               levels deep), the same department code in two org units, folders and sub-folders
 *   people      ~30 personas covering every role and every awkward case: multi-department, multi-role, no role,
 *               no department, deactivated, department heads at every level, a per-user permission override
 *   types       document types with every governance mix (none / approval / signature / audit / scoped)
 *   documents   every supported format (pdf, docx, xlsx, png, jpg, txt, csv), every classification, versions,
 *               drafts, active, in review, approved, declined, changes-requested, archived, trashed, legal hold
 *   approvals   chains in each state, including a refused self-approval
 *   ACL         user ALLOW/DENY, role DENY, folder DENY, expired grant, deliberate grant beside a snapshot row
 *   letters     outgoing letter in each stage, incoming letter, confidential letter
 *   forms       templates (department, org-unit and tenant scope) and filled instances
 *   checks      an expected-vs-actual access matrix per persona; every mismatch is printed and the run exits 1
 *
 * Passwordless: with LOCAL_JWT_MOCK=true in backend/.env, POST /auth/login {email} signs in as any persona
 * (the screens' dev login page offers the same). Flip LOCAL_JWT_MOCK back to false when you are done testing.
 * Nothing here sends mail (dev SMTP is MailHog) and it never touches another tenant.
 *
 *   npm run db:seed:qa        (from backend; safe to run again — whatever exists is left alone)
 *
 * Refuses unless NODE_ENV=development and the database is the dev one. There is no override on purpose.
 */
import '../src/config/env.js';
import { config } from '../src/config/env.js';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Document as DocxDocument, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { Op } from 'sequelize';
import {
  AclEntry, ApprovalChainTemplate, Department, Document, DocumentType, FolderNode, LegalHold, DocumentLegalHold, OrgUnit,
  Role, Tenant, User, UserDepartment, UserPermissionOverride, UserRole, UserTenant, initModels, sequelize,
} from '../src/infrastructure/database/index.js';
import { ROLE_PERMISSIONS } from '../src/config/permissions.js';
import { resolveUnionPermissions } from '../src/modules/roles/roles.service.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';
import { createTenant } from '../src/modules/tenants/tenants.service.js';
import { createDepartment } from '../src/modules/departments/departments.service.js';
import { createUser, deactivateUser } from '../src/modules/users/users.service.js';
import { createDocumentType } from '../src/modules/document-types/documentTypes.service.js';
import { createFolder } from '../src/modules/folders/folders.service.js';
import { createAclEntry } from '../src/modules/acl/acl.service.js';
import { upsertChainTemplate, submitForApproval, decideStep, getChain } from '../src/modules/approvals/approvals.service.js';
import {
  createDocument, uploadVersion, checkoutDocument, archiveDocument, deleteDocument, publishDraft, getDocument, listDocuments,
} from '../src/modules/documents/documents.service.js';
import { resolveACL } from '../src/shared/resolveACL.js';
import { createLetter, submitLetter, registerIncomingLetter } from '../src/modules/letters/letters.service.js';
import { createFormTemplate, createFormInstance } from '../src/modules/forms/forms.service.js';

const TENANT = 'qa-lab';
const DOMAIN = 'qa.local';

// ───────────────────────────── reporting ─────────────────────────────
const results: { name: string; ok: boolean; detail?: string }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const v = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
    return v;
  } catch (e) {
    const msg = e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}`.trim() : String(e);
    results.push({ name, ok: false, detail: msg });
    console.log(`  ✗ ${name} — ${msg}`);
    return undefined;
  }
}
/** A step that MUST be refused: passes when the call throws, fails when it succeeds. */
async function mustRefuse(name: string, fn: () => Promise<unknown>, codePart?: string) {
  try {
    await fn();
    results.push({ name, ok: false, detail: 'was allowed but should have been refused' });
    console.log(`  ✗ ${name} — was allowed but should have been refused`);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    const ok = !codePart || code.includes(codePart) || String((e as Error).message).includes(codePart);
    results.push({ name, ok, detail: ok ? undefined : `refused with ${code}, expected ${codePart}` });
    console.log(ok ? `  ✓ ${name} (refused: ${code})` : `  ✗ ${name} — refused with ${code}, expected ${codePart}`);
  }
}

// ───────────────────────────── file makers ─────────────────────────────
type Made = { buffer: Buffer; mime: string; ext: string };
async function makePdf(title: string, body: string): Promise<Made> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(title, { x: 50, y: 720, size: 18, font, color: rgb(0.1, 0.1, 0.3) });
  page.drawText(body, { x: 50, y: 680, size: 11, font, maxWidth: 500 });
  return { buffer: Buffer.from(await pdf.save()), mime: 'application/pdf', ext: 'pdf' };
}
async function makeDocx(title: string, body: string): Promise<Made> {
  const doc = new DocxDocument({ sections: [{ children: [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: body, size: 24 })] }),
  ] }] });
  return { buffer: Buffer.from(await Packer.toBuffer(doc)), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
}
async function makeXlsx(title: string): Promise<Made> {
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet('Sheet1');
  sh.addRow([title]); sh.addRow(['Item', 'Qty', 'Amount']); sh.addRow(['Widget', 4, 120.5]); sh.addRow(['Gadget', 2, 80]);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}
async function makeImage(title: string, fmt: 'png' | 'jpeg'): Promise<Made> {
  const svg = `<svg width="640" height="480"><rect width="640" height="480" fill="#2563eb"/><text x="320" y="240" font-size="22" fill="white" text-anchor="middle">${title}</text></svg>`;
  const img = sharp(Buffer.from(svg));
  return fmt === 'png'
    ? { buffer: await img.png().toBuffer(), mime: 'image/png', ext: 'png' }
    : { buffer: await img.jpeg().toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
}
const makeTxt = (title: string): Made => ({ buffer: Buffer.from(`${title}\n\nPlain text sample for the QA tenant.\n`), mime: 'text/plain', ext: 'txt' });
const makeCsv = (): Made => ({ buffer: Buffer.from('id,name,amount\n1,Alpha,10\n2,Beta,20\n'), mime: 'text/csv', ext: 'csv' });

const shim = (m: Made, name: string) => ({
  fieldname: 'file', originalname: `${name}.${m.ext}`, encoding: '7bit', mimetype: m.mime, size: m.buffer.length, buffer: m.buffer,
}) as unknown as Express.Multer.File;

// ───────────────────────────── personas ─────────────────────────────
type P = { key: string; roles: string[]; depts: string[]; first: string; last: string; inactive?: boolean; stripRoles?: boolean };
// dept keys: HQ-FIN HQ-FAP HQ-FAR HQ-HR HQ-OPS NO-SAL NO-FIN OU-STO SI-ENG
const PERSONAS: P[] = [
  { key: 'sysadmin', roles: ['SYSTEM_ADMIN'], depts: ['HQ-FIN'], first: 'Sys', last: 'Admin' },
  { key: 'exec', roles: ['EXECUTIVE'], depts: [], first: 'Exec', last: 'Chief' },
  { key: 'auditor', roles: ['AUDITOR'], depts: [], first: 'Audit', last: 'Reader' },
  { key: 'records', roles: ['RECORDS_OFFICER'], depts: ['HQ-FIN'], first: 'Records', last: 'Officer' },
  { key: 'fin.head', roles: ['DEPT_MANAGER'], depts: ['HQ-FIN'], first: 'Fin', last: 'Head' },
  { key: 'fap.head', roles: ['DEPT_MANAGER'], depts: ['HQ-FAP'], first: 'Payables', last: 'Head' },
  { key: 'fin.approver', roles: ['APPROVER'], depts: ['HQ-FIN'], first: 'Fin', last: 'Approver' },
  { key: 'fin.staff1', roles: ['EMPLOYEE'], depts: ['HQ-FIN'], first: 'Fin', last: 'Staff One' },
  { key: 'fin.staff2', roles: ['EMPLOYEE'], depts: ['HQ-FIN'], first: 'Fin', last: 'Staff Two' },
  { key: 'fap.staff', roles: ['EMPLOYEE'], depts: ['HQ-FAP'], first: 'Payables', last: 'Staff' },
  { key: 'far.staff', roles: ['EMPLOYEE'], depts: ['HQ-FAR'], first: 'Receivables', last: 'Staff' },
  { key: 'hr.head', roles: ['DEPT_MANAGER'], depts: ['HQ-HR'], first: 'Hr', last: 'Head' },
  { key: 'hr.staff', roles: ['EMPLOYEE'], depts: ['HQ-HR'], first: 'Hr', last: 'Staff' },
  { key: 'ops.head', roles: ['DEPT_MANAGER'], depts: ['HQ-OPS'], first: 'Ops', last: 'Head' },
  { key: 'ops.staff', roles: ['EMPLOYEE'], depts: ['HQ-OPS'], first: 'Ops', last: 'Staff' },
  { key: 'multi.dept', roles: ['EMPLOYEE'], depts: ['HQ-FIN', 'HQ-HR'], first: 'Multi', last: 'Department' },
  { key: 'multi.role', roles: ['EMPLOYEE', 'APPROVER'], depts: ['HQ-FIN'], first: 'Multi', last: 'Role' },
  { key: 'no.role', roles: ['EMPLOYEE'], stripRoles: true, depts: ['HQ-OPS'], first: 'No', last: 'Role' },
  { key: 'no.dept', roles: ['EMPLOYEE'], depts: [], first: 'No', last: 'Department' },
  { key: 'override', roles: ['EMPLOYEE'], depts: ['HQ-FIN'], first: 'Permission', last: 'Override' },
  { key: 'inactive', roles: ['EMPLOYEE'], depts: ['HQ-FIN'], first: 'Deactivated', last: 'Person', inactive: true },
  { key: 'north.head', roles: ['DEPT_MANAGER'], depts: ['NO-SAL'], first: 'North', last: 'Sales Head' },
  { key: 'north.staff', roles: ['EMPLOYEE'], depts: ['NO-SAL'], first: 'North', last: 'Sales Staff' },
  { key: 'north.fin', roles: ['EMPLOYEE'], depts: ['NO-FIN'], first: 'North', last: 'Finance Staff' },
  { key: 'store.staff', roles: ['EMPLOYEE'], depts: ['OU-STO'], first: 'Store', last: 'Staff' },
  { key: 'eng.head', roles: ['DEPT_MANAGER'], depts: ['SI-ENG'], first: 'Eng', last: 'Head' },
  { key: 'eng.staff', roles: ['EMPLOYEE'], depts: ['SI-ENG'], first: 'Eng', last: 'Staff' },
];
const email = (key: string) => `qa.${key}@${DOMAIN}`;

async function main() {
  if (process.env.NODE_ENV !== 'development' || String(config.DB_NAME) !== 'DMS') {
    console.error(`Refusing: the QA world seeds the development database only (NODE_ENV=${process.env.NODE_ENV}, DB=${config.DB_NAME}).`);
    process.exit(2);
  }
  initModels();
  await sequelize.authenticate();
  console.log('Connected to', sequelize.config.database, '→ tenant', TENANT);

  // the actor for provisioning: the platform administrator, else any system admin
  const actorRole = (await Role.findOne({ where: { name: 'PLATFORM_ADMIN' } })) ?? (await Role.findOne({ where: { name: 'SYSTEM_ADMIN' } }));
  const actorRow = actorRole ? await UserRole.findOne({ where: { roleId: actorRole.id } }) : null;
  if (!actorRow) throw new Error('No PLATFORM_ADMIN / SYSTEM_ADMIN user exists — seed the platform admin first.');
  const actorId = actorRow.userId;
  const allPerms = ROLE_PERMISSIONS.PLATFORM_ADMIN;
  const root = { userId: actorId, role: actorRole!.name, roles: [actorRole!.name], tenantId: TENANT, permissions: [...allPerms] };

  // ─── tenant ───
  await step('tenant qa-lab', async () => {
    if (await Tenant.findByPk(TENANT)) return;
    await createTenant({ id: TENANT, name: 'QA Laboratory', maxUsers: 500, maxDocuments: 100000 }, actorId);
  });

  const roleId = new Map((await Role.findAll()).map((r) => [r.name, r.id]));
  const unit = new Map<string, OrgUnit>();
  const dept = new Map<string, Department>();
  const folder = new Map<string, FolderNode>();
  const dtype = new Map<string, DocumentType>();
  const uid = new Map<string, string>();

  // ─── structure ───
  await withWorkerTenantContext(TENANT, async () => {
    console.log('Organisation units and departments');
    const hq = await OrgUnit.findOne({ where: { tenantId: TENANT, code: 'HQ' } });
    if (!hq) throw new Error('HQ org unit missing');
    unit.set('HQ', hq);
    for (const [code, name, unitType] of [['BR-NORTH', 'North Branch', 'BRANCH'], ['OUT-MALL', 'Mall Outlet', 'OUTLET'], ['SIS-TECH', 'Tech Sister Company', 'SISTER_COMPANY']] as const) {
      const [u] = await OrgUnit.findOrCreate({ where: { tenantId: TENANT, code }, defaults: { tenantId: TENANT, code, name, unitType } as never });
      unit.set(code, u);
    }
    const mk = async (key: string, orgUnit: string, code: string, name: string, parentKey?: string) => {
      let row = await Department.findOne({ where: { tenantId: TENANT, orgUnitId: unit.get(orgUnit)!.id, code } });
      if (!row) {
        const made = (await createDepartment({ orgUnitId: unit.get(orgUnit)!.id, code, name, parentId: parentKey ? dept.get(parentKey)!.id : null }, actorId, TENANT)) as { id: string };
        row = (await Department.findByPk(made.id))!;
      }
      dept.set(key, row);
    };
    await mk('HQ-FIN', 'HQ', 'FIN', 'Finance');
    await mk('HQ-FAP', 'HQ', 'FIN-AP', 'Accounts Payable', 'HQ-FIN');
    await mk('HQ-FAR', 'HQ', 'FIN-AR', 'Accounts Receivable', 'HQ-FIN');
    await mk('HQ-HR', 'HQ', 'HR', 'Human Resources');
    await mk('HQ-OPS', 'HQ', 'OPS', 'Operations');
    await mk('NO-SAL', 'BR-NORTH', 'SALES', 'Sales');
    await mk('NO-FIN', 'BR-NORTH', 'FIN', 'Finance (North)'); // same code as HQ Finance, different org unit
    await mk('OU-STO', 'OUT-MALL', 'STORE', 'Store Floor');
    await mk('SI-ENG', 'SIS-TECH', 'ENG', 'Engineering');
  });

  // ─── people ───
  console.log('People');
  await withWorkerTenantContext(TENANT, async () => {
    for (const p of PERSONAS) {
      await step(`user ${email(p.key)} [${p.roles.join('+') || 'no role'}] in ${p.depts.join(',') || 'no department'}`, async () => {
        const existing = await User.findOne({ where: { email: email(p.key) } });
        if (existing) { uid.set(p.key, existing.id); return; }
        const made = await createUser({
          email: email(p.key), firstName: p.first, lastName: p.last, isActive: true,
          roleIds: p.roles.map((r) => roleId.get(r)!), departmentIds: p.depts.map((d) => dept.get(d)!.id),
        }, { userId: actorId, tenantId: TENANT, permissions: allPerms });
        uid.set(p.key, made.id);
      });
      // createUser insists on one role; a person with NO role is made by taking it away afterwards
      if (p.stripRoles && uid.has(p.key)) await UserRole.destroy({ where: { userId: uid.get(p.key)! } });
    }
  });
  for (const p of PERSONAS) if (!uid.has(p.key)) { const u = await User.findOne({ where: { email: email(p.key) } }); if (u) uid.set(p.key, u.id); }

  const personaUser = async (key: string) => {
    const p = PERSONAS.find((x) => x.key === key)!;
    // a person with no stored role signs in as EMPLOYEE (what mock login and the token fallback do)
    const roles = p.roles.length ? p.roles : ['EMPLOYEE'];
    const permissions = await resolveUnionPermissions(roles, TENANT, uid.get(key));
    return { userId: uid.get(key)!, role: roles[0], roles, tenantId: TENANT, permissions: [...permissions] };
  };

  await withWorkerTenantContext(TENANT, async () => {
    await step('per-user permission override (document:read_all) for qa.override', async () => {
      await UserPermissionOverride.findOrCreate({
        where: { tenantId: TENANT, userId: uid.get('override')!, permission: 'document:read_all', effect: 'GRANT' },
        defaults: { tenantId: TENANT, userId: uid.get('override')!, permission: 'document:read_all', effect: 'GRANT' } as never,
      });
    });
    // tenant memberships for the cross-tenant persona (sysadmin also belongs to the demo tenant when it exists)
  });

  // ─── document types, folders ───
  console.log('Document types and folders');
  await withWorkerTenantContext(TENANT, async () => {
    const types: { code: string; name: string; dept?: string; approval?: boolean; sign?: boolean; audit?: 'required' | 'optional' | 'never' }[] = [
      { code: 'QA-GEN', name: 'General (no approval)' },
      { code: 'QA-APPR', name: 'Needs approval', dept: 'HQ-FIN', approval: true },
      { code: 'QA-SIGN', name: 'Needs signature', dept: 'HQ-FIN', sign: true },
      { code: 'QA-AUD', name: 'Approval + audit', dept: 'HQ-FIN', approval: true, audit: 'required' },
      { code: 'QA-APSG', name: 'Approval then signature', dept: 'HQ-FIN', approval: true, sign: true },
      { code: 'QA-HR', name: 'HR only type', dept: 'HQ-HR' },
      { code: 'QA-OPS', name: 'Operations type', dept: 'HQ-OPS' },
    ];
    for (const t of types) {
      await step(`document type ${t.code}`, async () => {
        let row = await DocumentType.findOne({ where: { tenantId: TENANT, code: t.code } });
        if (!row) {
          row = (await createDocumentType({
            code: t.code, name: t.name, departmentId: t.dept ? dept.get(t.dept)!.id : null, defaultRetentionClass: 'RET-CORP-5Y',
            requiresSignature: !!t.sign, signatoryRole: null, auditPolicy: t.audit ?? 'never', requiresApproval: !!t.approval, reapprovalPolicy: 'none', isActive: true,
          }, actorId, TENANT)) as DocumentType;
        }
        dtype.set(t.code, row);
      });
    }
    for (const [dk, names] of [['HQ-FIN', ['Open', 'Restricted']], ['HQ-HR', ['Personnel', 'Policies']], ['HQ-OPS', ['Runbooks']], ['NO-SAL', ['Deals']], ['SI-ENG', ['Specs']]] as const) {
      for (const n of names) {
        await step(`folder ${dk}/${n}`, async () => {
          const found = await FolderNode.findOne({ where: { tenantId: TENANT, departmentId: dept.get(dk)!.id, name: n } });
          if (found) { folder.set(`${dk}/${n}`, found); return; }
          const made = (await createFolder({ name: n, departmentId: dept.get(dk)!.id }, actorId, TENANT, allPerms)) as { id: string };
          folder.set(`${dk}/${n}`, (await FolderNode.findByPk(made.id))!);
        });
      }
    }
    await step('sub-folder HQ-FIN/Open/2026', async () => {
      const parent = folder.get('HQ-FIN/Open')!;
      const found = await FolderNode.findOne({ where: { tenantId: TENANT, parentId: parent.id, name: '2026' } });
      if (found) { folder.set('HQ-FIN/Open/2026', found); return; }
      const made = (await createFolder({ name: '2026', departmentId: dept.get('HQ-FIN')!.id, parentId: parent.id }, actorId, TENANT, allPerms)) as { id: string };
      folder.set('HQ-FIN/Open/2026', (await FolderNode.findByPk(made.id))!);
    });
    await step('approval chain for QA-APPR (records review → manager approval)', async () => {
      if (await ApprovalChainTemplate.findOne({ where: { tenantId: TENANT, documentTypeId: dtype.get('QA-APPR')!.id, isActive: true } })) return;
      await upsertChainTemplate({
        documentTypeId: dtype.get('QA-APPR')!.id, departmentId: dept.get('HQ-FIN')!.id, name: 'QA — records review then manager',
        steps: [{ stepType: 'REVIEW', assignedRole: 'RECORDS_OFFICER', slaHours: 24, locked: true }, { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', slaHours: 48, locked: true }],
      }, root);
    });
    await step('approval chain for QA-APSG (records review → manager approval, then signature)', async () => {
      if (await ApprovalChainTemplate.findOne({ where: { tenantId: TENANT, documentTypeId: dtype.get('QA-APSG')!.id, isActive: true } })) return;
      await upsertChainTemplate({
        documentTypeId: dtype.get('QA-APSG')!.id, departmentId: dept.get('HQ-FIN')!.id, name: 'QA — approve then sign',
        steps: [{ stepType: 'REVIEW', assignedRole: 'RECORDS_OFFICER', slaHours: 24, locked: true }, { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', slaHours: 48, locked: true }],
      }, root);
    });
    await step('approval chain for QA-AUD (named approver)', async () => {
      if (await ApprovalChainTemplate.findOne({ where: { tenantId: TENANT, documentTypeId: dtype.get('QA-AUD')!.id, isActive: true } })) return;
      await upsertChainTemplate({
        documentTypeId: dtype.get('QA-AUD')!.id, departmentId: dept.get('HQ-FIN')!.id, name: 'QA — named approver',
        steps: [{ stepType: 'APPROVE', assignedUserId: uid.get('fin.approver'), slaHours: 24, locked: true }],
      }, root);
    });
  });

  // ─── documents ───
  console.log('Documents');
  const doc = new Map<string, string>();
  const upload = async (key: string, who: string, title: string, deptKey: string, type: string, made: Made, extra: Record<string, unknown> = {}) => {
    await step(`document ${key} (${made.ext}, ${extra.securityClassification ?? 'INTERNAL'}) by ${who}`, async () => {
      const found = await Document.findOne({ where: { tenantId: TENANT, title } });
      if (found) { doc.set(key, found.id); return; }
      const user = await personaUser(who);
      const created = await withWorkerTenantContext(TENANT, () => createDocument({
        title, departmentId: dept.get(deptKey)!.id, documentTypeCode: type, organisationUnit: 'QA Laboratory',
        securityClassification: 'INTERNAL', sensitivityLabel: 'Internal', retentionClass: 'RET-CORP-5Y', source: 'MANUAL_UPLOAD',
        folderPath: extra.folderPath, ...extra,
      }, shim(made, title.replace(/\W+/g, '-')), user)) as { id?: string; document?: { id: string } };
      doc.set(key, (created.id ?? created.document?.id)!);
    });
  };
  const fp = (k: string) => folder.get(k)?.path;
  await upload('fin-pdf', 'fin.staff1', 'QA Finance PDF report', 'HQ-FIN', 'QA-GEN', await makePdf('Finance PDF', 'Quarterly numbers.'), { folderPath: fp('HQ-FIN/Open') });
  await upload('fin-docx', 'fin.staff1', 'QA Finance Word memo', 'HQ-FIN', 'QA-GEN', await makeDocx('Finance memo', 'A memo.'), { folderPath: fp('HQ-FIN/Open/2026') });
  await upload('fin-docx2', 'fin.staff2', 'QA Finance Word memo by staff two', 'HQ-FIN', 'QA-GEN', await makeDocx('Second memo', 'Owned by staff two.'), { folderPath: fp('HQ-FIN/Open/2026') });
  await upload('fin-xlsx', 'fin.staff2', 'QA Finance Excel ledger', 'HQ-FIN', 'QA-GEN', await makeXlsx('Ledger'), { folderPath: fp('HQ-FIN/Open') });
  await upload('fin-png', 'fin.staff1', 'QA Finance PNG scan', 'HQ-FIN', 'QA-GEN', await makeImage('Scan PNG', 'png'));
  await upload('fin-jpg', 'fin.staff1', 'QA Finance JPG scan', 'HQ-FIN', 'QA-GEN', await makeImage('Scan JPG', 'jpeg'));
  await upload('fin-txt', 'fin.staff1', 'QA Finance text note', 'HQ-FIN', 'QA-GEN', makeTxt('Finance note'));
  await upload('fin-csv', 'fin.staff1', 'QA Finance CSV export', 'HQ-FIN', 'QA-GEN', makeCsv());
  await upload('fin-conf', 'fin.head', 'QA Finance confidential salaries', 'HQ-FIN', 'QA-GEN', await makePdf('Salaries', 'Confidential.'), { securityClassification: 'CONFIDENTIAL', sensitivityLabel: 'Confidential', folderPath: fp('HQ-FIN/Restricted') });
  await upload('fin-restricted', 'fin.head', 'QA Finance restricted merger plan', 'HQ-FIN', 'QA-GEN', await makePdf('Merger', 'Restricted.'), { securityClassification: 'RESTRICTED', sensitivityLabel: 'Restricted', folderPath: fp('HQ-FIN/Restricted') });
  await upload('fin-public', 'fin.staff1', 'QA Finance public notice', 'HQ-FIN', 'QA-GEN', await makePdf('Public', 'Public notice.'), { securityClassification: 'PUBLIC', sensitivityLabel: 'Public' });
  await upload('fap-pdf', 'fap.staff', 'QA Payables invoice batch', 'HQ-FAP', 'QA-GEN', await makePdf('AP invoices', 'Invoices.'));
  await upload('far-pdf', 'far.staff', 'QA Receivables statement', 'HQ-FAR', 'QA-GEN', await makePdf('AR statement', 'Statement.'));
  await upload('hr-pdf', 'hr.staff', 'QA HR leave policy', 'HQ-HR', 'QA-HR', await makePdf('Leave policy', 'Policy.'), { folderPath: fp('HQ-HR/Policies') });
  await upload('hr-conf', 'hr.head', 'QA HR disciplinary record', 'HQ-HR', 'QA-HR', await makePdf('Disciplinary', 'Confidential.'), { securityClassification: 'CONFIDENTIAL', sensitivityLabel: 'Confidential', folderPath: fp('HQ-HR/Personnel') });
  await upload('ops-pdf', 'ops.staff', 'QA Operations runbook', 'HQ-OPS', 'QA-OPS', await makePdf('Runbook', 'Steps.'), { folderPath: fp('HQ-OPS/Runbooks') });
  await upload('north-pdf', 'north.staff', 'QA North sales deal', 'NO-SAL', 'QA-GEN', await makePdf('Deal', 'North deal.'), { folderPath: fp('NO-SAL/Deals') });
  await upload('northfin-pdf', 'north.fin', 'QA North finance ledger', 'NO-FIN', 'QA-GEN', await makePdf('North ledger', 'Ledger.'));
  await upload('store-pdf', 'store.staff', 'QA Store opening checklist', 'OU-STO', 'QA-GEN', await makePdf('Checklist', 'Open at 8.'));
  await upload('eng-pdf', 'eng.staff', 'QA Engineering spec', 'SI-ENG', 'QA-GEN', await makePdf('Spec', 'Spec.'), { folderPath: fp('SI-ENG/Specs') });
  await upload('appr-1', 'fin.staff1', 'QA Approval doc — will be approved', 'HQ-FIN', 'QA-APPR', await makePdf('To approve', 'Approve me.'));
  await upload('appr-2', 'fin.staff1', 'QA Approval doc — will be declined', 'HQ-FIN', 'QA-APPR', await makePdf('To decline', 'Decline me.'));
  await upload('appr-3', 'fin.staff2', 'QA Approval doc — changes requested', 'HQ-FIN', 'QA-APPR', await makePdf('To revise', 'Revise me.'));
  await upload('appr-4', 'fin.staff1', 'QA Approval doc — left pending', 'HQ-FIN', 'QA-APPR', await makePdf('Pending', 'Waiting.'));
  await upload('appr-5', 'fin.staff1', 'QA Approval doc — named approver', 'HQ-FIN', 'QA-AUD', await makePdf('Named', 'Named approver.'));
  await upload('sign-1', 'fin.staff1', 'QA Signature contract', 'HQ-FIN', 'QA-SIGN', await makePdf('Contract', 'Sign me.'));

  // versions
  await step('new version of the Word memo (v2.0 major) and the PDF (v1.1 minor)', async () => {
    const user = await personaUser('fin.staff1');
    await withWorkerTenantContext(TENANT, async () => {
      const d = await Document.findByPk(doc.get('fin-docx')!);
      if (d && d.currentVersion === '1.0') {
        await checkoutDocument(doc.get('fin-docx')!, user, 'QA edit');
        await uploadVersion(doc.get('fin-docx')!, shim(await makeDocx('Finance memo v2', 'Revised.'), 'memo-v2'), true, 'Second edition', user);
      }
    });
    await withWorkerTenantContext(TENANT, async () => {
      const d = await Document.findByPk(doc.get('fin-pdf')!);
      if (d && d.currentVersion === '1.0') {
        await checkoutDocument(doc.get('fin-pdf')!, user, 'QA typo');
        await uploadVersion(doc.get('fin-pdf')!, shim(await makePdf('Finance PDF v1.1', 'Minor fix.'), 'pdf-v11'), false, 'Typo fix', user);
      }
    });
  });

  // publish the drafts that need no approval
  for (const k of ['fin-pdf', 'fin-docx', 'fin-docx2', 'fin-xlsx', 'fap-pdf', 'hr-pdf', 'ops-pdf', 'north-pdf']) {
    await step(`publish draft ${k}`, async () => {
      const d = await Document.findByPk(doc.get(k)!);
      if (!d || d.status !== 'DRAFT') return;
      const owner = PERSONAS.find((p) => uid.get(p.key) === d.ownerId)!;
      await withWorkerTenantContext(TENANT, async () => { await publishDraft(d.id, await personaUser(owner.key)); });
    });
  }

  // ─── approvals ───
  console.log('Approvals');
  const itemType = 'DOCUMENT' as const;
  const submit = (key: string, who: string, extra: Record<string, unknown> = {}) =>
    step(`submit ${key} for approval as ${who}`, async () => {
      const d = await Document.findByPk(doc.get(key)!);
      if (!d || d.status !== 'DRAFT') return;
      await withWorkerTenantContext(TENANT, async () => { await submitForApproval(itemType, doc.get(key)!, extra, await personaUser(who)); });
    });
  const pending = async (key: string, who: string) => {
    const chain = (await withWorkerTenantContext(TENANT, async () => getChain(itemType, doc.get(key)!, await personaUser(who)))) as { chain?: { id: string; steps?: { id: string; status: string; stepType?: string }[] }; id?: string; steps?: { id: string; status: string; stepType?: string }[] };
    const c = chain.chain ?? chain;
    const open = c.steps?.find((s) => s.status === 'PENDING');
    return { chainId: c.id!, stepId: open?.id, stepType: open?.stepType };
  };
  const decide = (name: string, key: string, who: string, decision: 'APPROVE' | 'DECLINE' | 'REQUEST_CHANGES', comment?: string, stepType?: 'REVIEW' | 'APPROVE') =>
    step(name, async () => {
      const { chainId, stepId, stepType: open } = await pending(key, who);
      if (!stepId || (stepType && open !== stepType)) return; // this step was already decided in an earlier run
      await withWorkerTenantContext(TENANT, async () => { await decideStep(chainId, stepId, { decision, comment }, await personaUser(who)); });
    });
  await submit('appr-1', 'fin.staff1'); await submit('appr-2', 'fin.staff1'); await submit('appr-3', 'fin.staff2');
  await submit('appr-4', 'fin.staff1'); await submit('appr-5', 'fin.staff1');
  await decide('review step of appr-1 by records officer', 'appr-1', 'records', 'APPROVE', 'Looks complete', 'REVIEW');
  await decide('final step of appr-1 by finance head (approved)', 'appr-1', 'fin.head', 'APPROVE', 'Approved');
  await decide('review step of appr-2 by records officer', 'appr-2', 'records', 'APPROVE', undefined, 'REVIEW');
  await decide('final step of appr-2 by finance head (declined)', 'appr-2', 'fin.head', 'DECLINE', 'Not acceptable');
  await decide('review step of appr-3: changes requested', 'appr-3', 'records', 'REQUEST_CHANGES', 'Please attach the invoice', 'REVIEW');
  await decide('review step of appr-4 by records officer (leaves manager step pending)', 'appr-4', 'records', 'APPROVE', undefined, 'REVIEW');
  await mustRefuse('author cannot decide their own item (appr-5 → fin.staff1 is not the approver)', async () => {
    const { chainId, stepId } = await pending('appr-5', 'fin.approver');
    await withWorkerTenantContext(TENANT, async () => { await decideStep(chainId, stepId!, { decision: 'APPROVE' }, await personaUser('fin.staff1')); });
  });
  await mustRefuse('a user outside the department cannot approve (appr-4 manager step → hr.head)', async () => {
    const { chainId, stepId } = await pending('appr-4', 'fin.head');
    await withWorkerTenantContext(TENANT, async () => { await decideStep(chainId, stepId!, { decision: 'APPROVE' }, await personaUser('hr.head')); });
  });

  // ─── lifecycle states ───
  console.log('Archive, trash, legal hold');
  await step('archive the Excel ledger', async () => {
    const d = await Document.findByPk(doc.get('fin-xlsx')!);
    if (!d || d.status === 'ARCHIVED') return;
    await withWorkerTenantContext(TENANT, async () => { await archiveDocument(d.id, await personaUser('records')); });
  });
  await step('trash the CSV export', async () => {
    const d = await Document.findByPk(doc.get('fin-csv')!);
    if (!d || d.deletedAt) return;
    await withWorkerTenantContext(TENANT, async () => { await deleteDocument(d.id, await personaUser('fin.head')); });
  });
  await step('legal hold on the confidential salaries document', async () => {
    const d = await Document.findByPk(doc.get('fin-conf')!);
    if (!d || d.isOnLegalHold) return;
    await withWorkerTenantContext(TENANT, async () => {
      const [lh] = await LegalHold.findOrCreate({ where: { tenantId: TENANT, caseReference: 'QA-LH-001' }, defaults: { tenantId: TENANT, caseReference: 'QA-LH-001', description: 'QA investigation', custodianName: 'Legal', legalBasis: 'QA', expectedDuration: '1 month', status: 'ACTIVE', appliedById: actorId } as never });
      await DocumentLegalHold.findOrCreate({ where: { documentId: d.id, legalHoldId: lh.id }, defaults: { documentId: d.id, legalHoldId: lh.id } as never });
      await d.update({ isOnLegalHold: true });
    });
  });

  // ─── ACL edge cases ───
  console.log('Access-control edge cases');
  const acl = (name: string, type: 'document' | 'folder', resKey: string, principal: { type: 'user' | 'role'; id: string }, permission: string, effect: 'ALLOW' | 'DENY') =>
    step(name, async () => {
      const resourceId = type === 'document' ? doc.get(resKey)! : folder.get(resKey)!.id;
      const exists = await AclEntry.findOne({ where: { tenantId: TENANT, resourceType: type, resourceId, principalType: principal.type, principalId: principal.id, permission, effect } });
      if (exists && exists.origin !== 'DEPT_SNAPSHOT') return; // a department-snapshot row is promoted by createAclEntry
      await withWorkerTenantContext(TENANT, () => createAclEntry(type, resourceId, { principalType: principal.type, principalId: principal.id, permission, effect } as never, actorId, TENANT));
    });
  await acl('user ALLOW: qa.no.dept reads the Finance PDF', 'document', 'fin-pdf', { type: 'user', id: uid.get('no.dept')! }, 'document:read', 'ALLOW');
  await acl('user DENY: qa.fin.staff2 may not read the Finance PDF', 'document', 'fin-pdf', { type: 'user', id: uid.get('fin.staff2')! }, 'document:read', 'DENY');
  await acl('role DENY on folder Restricted for EMPLOYEE', 'folder', 'HQ-FIN/Restricted', { type: 'role', id: 'EMPLOYEE' }, 'document:read', 'DENY');
  await acl('user ALLOW inside the denied folder: qa.fin.staff1 reads salaries', 'document', 'fin-conf', { type: 'user', id: uid.get('fin.staff1')! }, 'document:read', 'ALLOW');
  await acl('user DENY on a whole folder: qa.fin.staff1 may not use Open/2026', 'folder', 'HQ-FIN/Open/2026', { type: 'user', id: uid.get('fin.staff1')! }, 'document:read', 'DENY');
  await step('expired grant (written straight into the table, the API refuses past dates)', async () => {
    const resourceId = doc.get('fin-png')!;
    await withWorkerTenantContext(TENANT, async () => {
      await AclEntry.findOrCreate({
        where: { tenantId: TENANT, resourceType: 'document', resourceId, principalType: 'user', principalId: uid.get('no.dept')!, permission: 'document:read', effect: 'ALLOW' },
        defaults: { tenantId: TENANT, resourceType: 'document', resourceId, principalType: 'user', principalId: uid.get('no.dept')!, permission: 'document:read', effect: 'ALLOW', expiresAt: new Date(Date.now() - 86_400_000), grantedById: actorId } as never,
      });
    });
  });
  await mustRefuse('a past expiry date is refused by the API', () =>
    withWorkerTenantContext(TENANT, () => createAclEntry('document', doc.get('fin-txt')!, { principalType: 'user', principalId: uid.get('no.dept')!, permission: 'document:read', effect: 'ALLOW', expiresAt: new Date(Date.now() - 1000).toISOString() } as never, actorId, TENANT)), 'ERR-EXPIRED-DATE');
  await mustRefuse('a role-wide document read grant is refused (would be tenant-wide)', () =>
    withWorkerTenantContext(TENANT, () => createAclEntry('document', doc.get('fin-txt')!, { principalType: 'role', principalId: 'EMPLOYEE', permission: 'document:read', effect: 'ALLOW' } as never, actorId, TENANT)));

  // ─── letters ───
  console.log('Letters');
  const hqId = unit.get('HQ')!.id;
  const letterBody = (t: string) => `<p>${t}</p><p>Yours faithfully,<br/>QA Laboratory</p>`;
  const letter = (key: string, who: string, input: Record<string, unknown>, after?: (id: string, user: Awaited<ReturnType<typeof personaUser>>) => Promise<void>) =>
    step(`letter ${key} by ${who}`, async () => {
      const user = await personaUser(who);
      const made = (await withWorkerTenantContext(TENANT, () => createLetter({ orgUnitId: hqId, departmentId: dept.get('HQ-FIN')!.id, bodyHtml: letterBody(String(input.subject)), ...input }, user))) as { id?: string; letter?: { id: string } };
      const id = (made.id ?? made.letter?.id)!;
      if (after) await withWorkerTenantContext(TENANT, () => after(id, user));
    });
  // the service does not de-duplicate by subject, so only create when no letter with that subject exists yet
  const subjectExists = async (subject: string) => ((await sequelize.query('SELECT 1 FROM letters WHERE tenant_id = :t AND subject = :s LIMIT 1', { replacements: { t: TENANT, s: subject } }))[0] as unknown[]).length > 0;
  if (!(await subjectExists('QA outgoing draft'))) await letter('draft', 'fin.staff1', { subject: 'QA outgoing draft', correspondent: 'Mr Example', correspondentOrganization: 'Example Ltd' });
  if (!(await subjectExists('QA outgoing awaiting approval'))) {
    await letter('submitted', 'fin.staff1', { subject: 'QA outgoing awaiting approval', correspondent: 'Ms Sample' }, async (id, user) => {
      await submitLetter(id, { steps: [{ stepType: 'APPROVE', assignedUserId: uid.get('fin.head') }] }, user);
    });
  }
  if (!(await subjectExists('QA confidential outgoing letter'))) await letter('confidential', 'fin.head', { subject: 'QA confidential outgoing letter', confidentiality: 'CONFIDENTIAL', correspondent: 'Board' });
  if (!(await subjectExists('QA incoming letter from supplier'))) {
    await step('incoming letter registered by fin.staff1', async () => {
      await withWorkerTenantContext(TENANT, async () => registerIncomingLetter({ orgUnitId: hqId, departmentId: dept.get('HQ-FIN')!.id, subject: 'QA incoming letter from supplier', correspondent: 'Supplier Co', priority: 'HIGH' }, undefined, await personaUser('fin.staff1')));
    });
  }
  if (!(await subjectExists('QA incoming confidential notice'))) {
    await step('incoming confidential letter registered by fin.head', async () => {
      await withWorkerTenantContext(TENANT, async () => registerIncomingLetter({ orgUnitId: hqId, departmentId: dept.get('HQ-FIN')!.id, subject: 'QA incoming confidential notice', correspondent: 'Regulator', confidentiality: 'CONFIDENTIAL' }, undefined, await personaUser('fin.head')));
    });
  }

  // ─── forms ───
  console.log('Forms');
  const fields = [[
    { name: 'full_name', type: 'text', required: true, position: { x: 50, y: 700 }, width: 250 },
    { name: 'amount', type: 'number', required: true, position: { x: 50, y: 660 }, width: 120 },
    { name: 'reason', type: 'textarea', position: { x: 50, y: 600 }, width: 400 },
    { name: 'needed_by', type: 'date', position: { x: 50, y: 560 }, width: 150 },
    { name: 'category', type: 'select', options: ['Travel', 'Supplies', 'Other'], position: { x: 50, y: 520 }, width: 150 },
  ]];
  const templateIds = new Map<string, string>();
  const template = (key: string, who: string, name: string, scope: { departmentId?: string | null; orgUnitId?: string | null }, extra: Record<string, unknown> = {}) =>
    step(`form template "${name}" by ${who}`, async () => {
      const exists = (await sequelize.query('SELECT id FROM form_templates WHERE tenant_id = :t AND lower(name) = lower(:n) LIMIT 1', { replacements: { t: TENANT, n: name } }))[0] as { id: string }[];
      if (exists.length) { templateIds.set(key, exists[0].id); return; }
      const user = await personaUser(who);
      const made = await withWorkerTenantContext(TENANT, () => createFormTemplate({ name, category: 'QA', schemaJson: fields, ...scope, ...extra } as never, user as never));
      templateIds.set(key, (made as { id: string }).id);
    });
  await template('dept', 'fin.head', 'QA Expense request (Finance only)', { departmentId: dept.get('HQ-FIN')!.id }, { instanceApproval: 'chain' });
  await template('unit', 'sysadmin', 'QA Visitor pass (HQ org unit)', { orgUnitId: hqId });
  await template('tenant', 'sysadmin', 'QA Tenant-wide feedback form', {});
  await mustRefuse('an employee cannot create a tenant-wide template', async () => {
    const user = await personaUser('fin.staff1');
    await withWorkerTenantContext(TENANT, () => createFormTemplate({ name: 'QA employee wide attempt', schemaJson: fields } as never, user as never));
  });
  for (const key of ['dept', 'unit', 'tenant']) {
    await step(`activate the "${key}" template through its approval`, async () => {
      const id = templateIds.get(key);
      const row = (await sequelize.query('SELECT status FROM form_templates WHERE id = :id', { replacements: { id } }))[0] as { status: string }[];
      if (!id || row[0]?.status === 'active') return;
      const owner = key === 'dept' ? 'fin.head' : 'sysadmin';
      const approver = key === 'dept' ? 'fin.approver' : 'exec';
      const ownerUser = await personaUser(owner);
      await withWorkerTenantContext(TENANT, () => submitForApproval('FORM_TEMPLATE', id, { steps: [{ stepType: 'APPROVE', assignedUserId: uid.get(approver) }] }, ownerUser));
      const chain = (await withWorkerTenantContext(TENANT, async () => getChain('FORM_TEMPLATE', id, await personaUser(approver)))) as { chain?: { id: string; steps?: { id: string; status: string }[] }; id?: string; steps?: { id: string; status: string }[] };
      const c = chain.chain ?? chain;
      const open = c.steps?.find((x) => x.status === 'PENDING');
      if (open) await withWorkerTenantContext(TENANT, async () => decideStep(c.id!, open.id, { decision: 'APPROVE' }, await personaUser(approver)));
    });
  }
  const instanceCount = async (n: string) => ((await sequelize.query('SELECT count(*)::int AS c FROM form_instances fi JOIN form_templates ft ON ft.id = fi.template_id WHERE ft.tenant_id = :t AND ft.name = :n', { replacements: { t: TENANT, n } }))[0] as { c: number }[])[0].c;
  for (const [key, name, who, deptKey, amount] of [['dept', 'QA Expense request (Finance only)', 'fin.staff1', 'HQ-FIN', 120], ['tenant', 'QA Tenant-wide feedback form', 'ops.staff', 'HQ-OPS', 5], ['unit', 'QA Visitor pass (HQ org unit)', 'hr.staff', 'HQ-HR', 1]] as const) {
    await step(`form instance of "${name}" filled by ${who}`, async () => {
      if (!templateIds.get(key) || (await instanceCount(name)) > 0) return;
      const user = await personaUser(who);
      const approvalSteps = key === 'dept' ? [{ stepType: 'APPROVE', assignedUserId: uid.get('fin.head') }] : undefined;
      await withWorkerTenantContext(TENANT, () => createFormInstance(templateIds.get(key)!, { full_name: 'Test Person', amount, reason: 'QA seed', needed_by: '2026-12-01', category: 'Other' }, user as never, dept.get(deptKey)!.id, undefined, approvalSteps));
    });
  }

  // ─── the access matrix: who can read what ───
  console.log('Access matrix (expected vs actual)');
  const canRead = async (who: string, key: string) => {
    const p = await personaUser(who);
    const d = await Document.findByPk(doc.get(key)!);
    if (!d) return false;
    const r = await withWorkerTenantContext(TENANT, () => resolveACL({
      resourceType: 'document', resourceId: d.id, permission: 'document:read', userId: p.userId, userRole: p.role, userRoles: p.roles, userPermissions: p.permissions, tenantId: TENANT,
    }));
    return r.allowed;
  };
  const matrix: [string, string, boolean, string, boolean?][] = [
    // [persona, document, expected, why]
    ['fin.staff1', 'fin-pdf', true, 'owner / department member'],
    ['fin.staff2', 'fin-pdf', false, 'direct user DENY'],
    ['no.dept', 'fin-pdf', true, 'direct user ALLOW though in no department'],
    ['hr.staff', 'fin-pdf', false, 'other department'],
    ['fin.head', 'fin-pdf', true, 'department head'],
    ['fap.head', 'fin-pdf', false, 'head of a SUB-department does not read the parent department by default'],
    ['fin.head', 'fap-pdf', false, 'owner decision 2026-10-09: a parent-department head is NOT a member of the sub-department, so does not read its documents'],
    ['fap.staff', 'fin-pdf', false, 'sub-department member vs parent documents'],
    ['north.fin', 'fin-pdf', false, 'same department code in another org unit'],
    ['auditor', 'fin-pdf', true, 'AUDITOR reads the whole tenant'],
    ['exec', 'fin-pdf', true, 'EXECUTIVE oversight read'],
    ['override', 'hr-pdf', true, 'per-user permission override document:read_all'],
    ['multi.dept', 'hr-pdf', true, 'member of two departments'],
    ['multi.dept', 'fin-pdf', true, 'member of two departments'],
    ['no.role', 'ops-pdf', true, 'no role but department member (treated as EMPLOYEE)'],
    ['no.dept', 'ops-pdf', false, 'no department, no grant'],
    ['fin.staff1', 'fin-conf', true, 'deliberate user ALLOW beats the folder role DENY'],
    ['fin.staff2', 'fin-conf', false, 'folder role DENY closes EMPLOYEE'],
    ['fin.head', 'fin-conf', true, 'head is not an EMPLOYEE-role denial target'],
    ['fin.staff1', 'fin-docx', true, 'owner keeps the document (owner grant is deliberate and more specific than the folder DENY)'],
    ['fin.staff1', 'fin-docx2', false, 'folder DENY on Open/2026 closes a department-snapshot read'],
    ['fin.staff2', 'fin-docx2', true, 'owner'],
    ['no.dept', 'fin-png', false, 'expired grant must not count'],
    ['store.staff', 'north-pdf', false, 'other org unit'],
    ['eng.staff', 'fin-pdf', false, 'sister company vs HQ'],
  ];
  for (const [who, key, expected, why, knownGap] of matrix) {
    const actual = await canRead(who, key);
    if (knownGap) {
      // an open product decision: reported, never failing the run (see docs/ACCESS findings)
      console.log(`  ⚠ ${who} ${expected ? 'CAN' : 'CANNOT'} read ${key} — ${why} → actual: ${actual ? 'allow' : 'deny'}${actual === expected ? ' (now matches)' : ' (OPEN DECISION)'}`);
      continue;
    }
    await step(`${who} ${expected ? 'CAN' : 'CANNOT'} read ${key} — ${why}`, async () => {
      if (actual !== expected) throw new Error(`expected ${expected ? 'allow' : 'deny'} but got ${actual ? 'allow' : 'deny'}`);
    });
  }

  // deactivate last so earlier steps could still act as them if they were needed
  await step('deactivate qa.inactive', async () => {
    const u = await User.findByPk(uid.get('inactive')!);
    if (!u || !u.isActive) return;
    await withWorkerTenantContext(TENANT, async () => { await deactivateUser(u.id, actorId); });
  });
  await step('no document of qa-lab is orphaned of an owner', async () => {
    const n = await Document.count({ where: { tenantId: TENANT, ownerId: { [Op.is]: null as never } } });
    if (n) throw new Error(`${n} documents without an owner`);
  });

  // ─── summary ───
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps ok`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(` - ${f.name}\n     ${f.detail}`);
  }
  console.log(`\nSign in (LOCAL_JWT_MOCK=true): POST /auth/login {"email":"${email('fin.staff1')}"} — all personas are qa.<key>@${DOMAIN}`);
  void crypto; void listDocuments; void getDocument; void UserDepartment; void UserTenant;
  await sequelize.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
