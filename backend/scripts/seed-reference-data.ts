/**
 * seed-reference-data.ts — Production-safe core seed (§0–§6 of seed-core.ts).
 *
 * Seeds ONLY what a fresh database needs to function: the `examplecorp`
 * tenant, the 7 global roles, org units, departments, document types,
 * retention policies, the folder tree, and the default 3-stage approval
 * workflow. Deliberately excludes everything seed-core.ts also does —
 * demo users, the fake "demo-org" tenant, and demo documents/workflow
 * instances/legal holds/e-sign records — none of which belong in production.
 *
 * Safe to re-run (uses findOrCreate / upsert), safe in production.
 * Run AFTER migrations: npm run db:migrate && npm run db:seed:reference
 */
import '../src/config/env.js';
import {
  Department,
  DocumentType,
  FolderNode,
  OrgUnit,
  RetentionPolicy,
  Role,
  Tenant,
  WorkflowDefinition,
  initModels,
  sequelize,
} from '../src/infrastructure/database/index.js';

const TENANT_ID = 'examplecorp';

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

async function upsert<T extends { id: string }>(Model: any, where: Record<string, unknown>, defaults: Record<string, unknown>, transaction?: any): Promise<T> {
  const [row] = await Model.findOrCreate({ where, defaults: { ...where, ...defaults }, transaction });
  return row as T;
}

async function main() {
  console.log('Connecting…');
  initModels();
  console.log('Connected to', sequelize.config.database);

  await sequelize.transaction(async (tx) => {
    await sequelize.query(`SET LOCAL app.current_tenant = '${TENANT_ID}'`, { transaction: tx });

    console.log('Seeding tenant…');
    await upsert(Tenant, { id: TENANT_ID }, { name: 'Example Corp', isActive: true, storageQuotaBytes: 10 * 1024 * 1024 * 1024, maxUsers: 100, maxDocuments: 10000 }, tx);

    console.log('Seeding roles…');
    for (const name of ROLES) await upsert(Role, { name }, { description: `${name} system role` }, tx);

    console.log('Seeding organizational units…');
    let hqUnit = await OrgUnit.findOne({ where: { tenantId: TENANT_ID, code: 'HQ' }, transaction: tx });
    if (!hqUnit) {
      hqUnit = await upsert<OrgUnit>(OrgUnit, { tenantId: TENANT_ID, code: 'HQ' }, { name: 'Headquarters', unitType: 'HQ' }, tx);
    }
    const regionalUnit = await upsert<OrgUnit>(OrgUnit, { tenantId: TENANT_ID, code: 'REG-WEST' }, { name: 'Regional Office — West', unitType: 'BRANCH' }, tx);

    console.log('Seeding departments…');
    const DEPT_ORG_UNIT: Record<string, string> = { AUDIT: regionalUnit.id };
    for (const [code, name] of DEPARTMENTS) {
      const orgUnitId = DEPT_ORG_UNIT[code] ?? hqUnit.id;
      await upsert(Department, { tenantId: TENANT_ID, code }, { name, isActive: true, orgUnitId }, tx);
    }

    console.log('Seeding document types…');
    for (const t of DOCUMENT_TYPES) {
      await upsert(DocumentType, { tenantId: TENANT_ID, code: t.code }, { name: t.name, defaultRetentionClass: t.retention, requiresSignature: t.sig, isActive: true }, tx);
    }

    console.log('Seeding retention policies…');
    for (const p of RETENTION_POLICIES) {
      await upsert(RetentionPolicy, { code: p.code }, { name: p.name, retentionYears: p.years, isPermanent: p.permanent, triggerEvent: p.trigger, disposalAction: p.disposal, authority: 'DMS Phase 1 Governance Policy', isActive: true }, tx);
    }

    console.log('Seeding folder tree…');
    const root = await upsert(FolderNode, { tenantId: TENANT_ID, path: '/' }, { name: 'DMS Repository', level: 0, parentId: null, departmentId: null, isSystemManaged: true }, tx);
    const org = await upsert(FolderNode, { tenantId: TENANT_ID, path: '/Example Corp' }, { name: 'Example Corp', level: 1, parentId: root.id, departmentId: null, isSystemManaged: true }, tx);
    for (const [code, name] of DEPARTMENTS) {
      const dept = await Department.findOne({ where: { tenantId: TENANT_ID, code }, transaction: tx });
      if (!dept) continue;
      const deptPath = `/Example Corp/${name}`;
      const deptFolder = await upsert(FolderNode, { tenantId: TENANT_ID, path: deptPath }, { name, level: 2, parentId: org.id, departmentId: dept.id, isSystemManaged: true }, tx);
      for (const cat of DEPT_CATEGORIES[name] ?? []) {
        await upsert(FolderNode, { tenantId: TENANT_ID, path: `${deptPath}/${cat}` }, { name: cat, level: 3, parentId: deptFolder.id, departmentId: dept.id, isSystemManaged: true }, tx);
      }
    }

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
    }, tx);
  });

  console.log('\nReference data seeded. No users were created — the first');
  console.log('SYSTEM_ADMIN is provisioned automatically on first SSO login');
  console.log(`for anyone in the mapped AD admin group (see idp_role_mappings,`);
  console.log('relying_party=\'edams\'), or create one via the admin API once');
  console.log('at least one SYSTEM_ADMIN exists.');
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
