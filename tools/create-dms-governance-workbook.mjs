import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

// The vendored xlsx@0.20.3 (vendor/xlsx-0.20.3.tgz — see the security-audit
// commit that pinned it) resolves `import ... from 'xlsx'` to its xlsx.mjs
// build via package.json's "exports"."import" condition. Unlike the CJS
// xlsx.js build, xlsx.mjs never auto-`require('fs')` — ESM has no synchronous
// require to fall back on — so XLSX.writeFile silently has no filesystem
// binding and throws "cannot save file" unless the host explicitly hands one
// in via set_fs. Without this line the generator cannot write the workbook at
// all under the currently-installed xlsx version.
XLSX.set_fs(nodeFs);

const outputDir = path.resolve('outputs');
const outputPath = path.join(outputDir, 'DMS_Department_Document_Governance_Discovery_Distribution_Ready.xlsx');

const NAVY = '17365D';
const BLUE = 'D9EAF7';
const GOLD = 'FFF2CC';
const GREEN = 'E2F0D9';
const GREY = 'F3F6F9';
const WHITE = 'FFFFFF';
const BORDER = 'B7C9D6';

function cell(value, opts = {}) {
  const c = { v: value, t: typeof value === 'number' ? 'n' : 's' };
  c.s = {
    font: { name: 'Aptos', sz: opts.size ?? 10, bold: Boolean(opts.bold), color: opts.fontColor ? { rgb: opts.fontColor } : undefined },
    fill: opts.fill ? { patternType: 'solid', fgColor: { rgb: opts.fill } } : undefined,
    alignment: { vertical: 'top', horizontal: opts.center ? 'center' : 'left', wrapText: opts.wrap !== false },
    border: opts.border ? {
      top: { style: 'thin', color: { rgb: BORDER } }, bottom: { style: 'thin', color: { rgb: BORDER } },
      left: { style: 'thin', color: { rgb: BORDER } }, right: { style: 'thin', color: { rgb: BORDER } },
    } : undefined,
  };
  return c;
}

function setRow(ws, excelRow, values, opts = {}) {
  values.forEach((value, column) => {
    ws[XLSX.utils.encode_cell({ r: excelRow - 1, c: column })] = cell(value, { border: true, ...opts });
  });
}

function addComment(ws, ref, text) {
  ws[ref].c = [{ t: text, a: 'Example Corp DMS discovery' }];
}

function makeInputSheet(title, purpose, headers, widths, inputRows) {
  const ws = {};
  const lastColumn = XLSX.utils.encode_col(headers.length - 1);
  ws.A1 = cell(title, { bold: true, size: 16, fontColor: WHITE, fill: NAVY, wrap: true });
  ws.A2 = cell(purpose, { fill: BLUE, wrap: true });
  ws['!merges'] = [XLSX.utils.decode_range(`A1:${lastColumn}1`), XLSX.utils.decode_range(`A2:${lastColumn}2`)];
  headers.forEach((header, column) => {
    ws[XLSX.utils.encode_cell({ r: 3, c: column })] = cell(header, { bold: true, fontColor: WHITE, fill: NAVY, center: true, border: true });
  });
  for (let row = 4; row < 4 + inputRows; row++) {
    headers.forEach((_, column) => {
      ws[XLSX.utils.encode_cell({ r: row, c: column })] = cell('', { fill: row % 2 === 0 ? WHITE : GREY, border: true });
    });
  }
  ws['!ref'] = `A1:${lastColumn}${3 + inputRows}`;
  ws['!cols'] = widths.map((wch) => ({ wch }));
  ws['!rows'] = [{ hpt: 28 }, { hpt: 38 }, { hpt: 46 }];
  ws['!autofilter'] = { ref: `A4:${lastColumn}${3 + inputRows}` };
  ws['!freeze'] = { xSplit: 0, ySplit: 4, topLeftCell: 'A5', activePane: 'bottomLeft', state: 'frozen' };
  return ws;
}

function makeGuideSheet(title, purpose, headers, widths, rows) {
  const ws = makeInputSheet(title, purpose, headers, widths, rows.length + 4);
  rows.forEach((row, index) => setRow(ws, index + 5, row, { fill: index % 2 === 0 ? GOLD : GREEN }));
  return ws;
}

const wb = XLSX.utils.book_new();
wb.Props = {
  Title: 'DMS Department, Document & Governance Discovery',
  Subject: 'Business-rule collection workbook',
  Author: 'Example Corp DMS discovery',
};

// 1. Read me
const readMe = {};
const readMeRows = [
  ['DMS Department, Document & Governance Discovery', '', '', ''],
  ['What this is for', 'A structured request for confirmed business rules, seeded with how DMS actually behaves today so every answer is something DMS can actually enforce. It is not a request to accept the existing seed/demo data or to redesign DMS from scratch.', '', ''],
  ['Who completes it', 'Department Manager: Department Profile, Document Type Register and User Roles & Access Assignment. Process/records owner: Workflow Rules, Forms & Correspondence and Governance & Retention. Executive/Legal/Records/IT Security: the high-risk, permanent, externally-binding, audit-retention and AI-consent decisions in Administration & Access.', '', ''],
  ['How to use the sheets', 'Start with Department Profile. Assign a stable Document Type ID (or Form Template ID) to every real record type or form and reuse that same ID in Workflow Rules and Governance & Retention, so each detailed rule is recorded once, not repeated.', '', ''],
  ['What the examples mean', 'Yellow rows are clear, code-derived examples only. Replace them or mark them Confirmed after the responsible owner validates them. They are deliberately not pre-approved policy.', '', ''],
  ['Lifecycle decisions are required', 'For every document type, state the upload entry state, what makes it operational, the state it settles in once the business process finishes, and who or what archives it. "Active immediately" always means the owner published DRAFT to ACTIVE directly because that type opted out of approval — DMS never creates a normal upload already ACTIVE.', '', ''],
  ['Current DMS design — documents & forms', 'One configurable approval engine serves Documents and Forms alike: strictly sequential Review/Approve steps (there is no parallel-step option), then an optional e-signing ceremony, then an optional named-auditor stage — always in that fixed order; signing can never be configured to run after audit. If a type needs neither signing nor audit, final approval alone turns it ACTIVE automatically. If it needs signing with no audit after it, completing signing moves it straight to ARCHIVED instead — it never becomes ACTIVE. If it needs audit — with or without signing first — a Pass at the audit stage takes it straight to ACTIVE instead: DMS treats a Pass as this record’s terminal clearance decision, the same effect an ordinary final approval would have, not a separate archived or "eligible to archive" state. A type that opts out of approval simply lets its owner publish, or discard, straight from Draft.', '', ''],
  ['Current DMS design — correspondence', 'Letters and memos run on their own, simpler engine. The drafter assembles the review/approval chain per letter from named people or roles — it is not a pre-set admin template — decisions are only Approve or Return (no audit stage, no Decline), and "signed" means a signatory block plus a verifiable QR code, not the e-signing ceremony documents use. Do not place correspondence steps into the Workflow Rules sheet.', '', ''],
  ['What DMS does not do yet', 'Please do not ask for, or assume the existence of: automatic SLA escalation to a higher authority (a breach only triggers a one-time reminder to the same people), delegation or out-of-office coverage, bulk import of documents, a "case closed" retention trigger, an administrative hold distinct from legal hold, parallel approval steps (e-signing order can be parallel; approval steps cannot), custom structured fields on a document type (only Forms have configurable fields), or a screen to browse past destruction certificates. (A packaged multi-document content export does now exist — see "Document bundle exports" in Administration & Access — so do not assume that one is missing.)', '', ''],
  ['What not to validate', 'The repository still contains an older per-role workflow-definition module and an unwired internal-PKI signing module. Both are superseded, reachable only by a direct API call, and never presented on any screen — this workbook is not asking anyone to validate either one.', '', ''],
  ['Completion standard', 'For each document type or form, identify the owner, business cycle, routing requirement, retention trigger, governing authority and any unresolved decision. Add policy names, approval limits, sample files or links under Notes/Evidence rather than guessing.', '', ''],
];
readMeRows.forEach((row, index) => setRow(readMe, index + 1, row, index === 0 ? { bold: true, size: 16, fontColor: WHITE, fill: NAVY } : { fill: index % 2 ? BLUE : WHITE }));
readMe['!merges'] = readMeRows.map((_, index) => XLSX.utils.decode_range(`B${index + 1}:D${index + 1}`));
readMe['!cols'] = [{ wch: 29 }, { wch: 118 }, { wch: 3 }, { wch: 3 }];
readMe['!rows'] = readMeRows.map((_, index) => ({ hpt: index === 0 ? 30 : 58 }));
readMe['!ref'] = `A1:D${readMeRows.length}`;
XLSX.utils.book_append_sheet(wb, readMe, 'Read Me');

// 2. Department profile — ownership + real hierarchy fields, nothing document-level.
const departmentHeaders = [
  'Response Status', 'Department Name', 'Department Code', 'Parent Department (blank if top-level)',
  'Org Unit (HQ / Branch / Outlet / Sister Company)', 'Department Manager (person to receive the DEPT_MANAGER role)',
  'Executive Sponsor', 'Records / DMS Contact', 'Business Mandate', 'Core Business Cycles', 'Key Dependencies',
  'Manager Sign-off Date', 'Open Questions / Evidence Needed',
];
const department = makeInputSheet(
  'Department Profile',
  'One row per department or sub-department. Use this sheet for ownership, hierarchy and operating context only — do not repeat document-level rules here.',
  departmentHeaders, [20, 24, 16, 28, 32, 30, 25, 25, 35, 37, 33, 21, 46], 44,
);
[
  ['Sample — replace or confirm', 'Finance', 'FIN', '', 'HQ', 'Department Manager', 'CFO', 'Records Officer', 'Financial governance and reporting', 'Procure-to-pay; record-to-report', 'Procurement; Legal; external suppliers', '', 'Seed department: confirm actual structure, owner and records contact.'],
  ['Sample — replace or confirm', 'Human Resources', 'HR', '', 'HQ', 'Department Manager', 'Chief People Officer', 'Records Officer', 'Employee lifecycle and workforce records', 'Recruit-to-retire; payroll inputs', 'Legal; payroll provider; employees', '', 'Seed department: validate legal-owner and employee-record scope.'],
  ['Sample — replace or confirm', 'Procurement', 'PROC', '', 'HQ', 'Department Manager', 'COO / CFO', 'Records Officer', 'Supplier sourcing and purchasing', 'Source-to-contract; procure-to-pay', 'Finance; Legal; Operations; suppliers', '', 'Seed department: validate approval thresholds and source systems.'],
  ['Sample — replace or confirm', 'Legal', 'LEG', '', 'HQ', 'Department Manager', 'General Counsel', 'Records Officer', 'Legal advice, contracts and compliance', 'Contract lifecycle; regulatory compliance', 'All departments; external counsel; regulators', '', 'Seed department: validate authority, hold ownership and contract records.'],
  ['Sample — replace or confirm', 'Payroll', 'HR-PAY', 'Human Resources', 'HQ', 'Department Manager', 'Chief People Officer', 'Records Officer', 'Payroll processing and statutory remittance', 'Monthly payroll run; year-end filings', 'Finance; HR; tax authority', '', 'Demonstrates a sub-department: Parent Department names the row above by its Department Name.'],
].forEach((row, index) => setRow(department, index + 5, row, { fill: GOLD }));
addComment(department, 'D5', 'Leave blank for a top-level department. For a real sub-department, type the exact Department Name of its parent row — DMS nests departments the same way.');
addComment(department, 'E5', 'Must be an existing Org Unit (HQ, or a named Branch, Outlet or Sister Company). If the one you need does not exist yet, say so under Open Questions so a System Admin can create it first.');
XLSX.utils.book_append_sheet(wb, department, 'Department Profile');

// 3. Document type register — the single source of truth for identity/context.
const documentHeaders = [
  'Response Status', 'Department Code', 'Document Type ID', 'Proposed DMS Code (max 10)', 'Document / Record Type',
  'Scope (Global / Department)', 'Business Cycle', 'Purpose / Decision Supported', 'Record or Working Document?',
  'Origin', 'Typical Format(s)', 'Sensitivity (PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED)', 'Primary Owner (business role/title)',
  'Authoritative Source / Repository', 'Volume / Timing', 'Required Metadata / Index Fields', 'DMS Routing Requirement',
  'Workflow ID (Doc Type or Form Template)', 'Upload Entry State', 'Activation / Submission Action', 'Target State After Workflow',
  'Archive / Closure Trigger & Owner', 'Retention Rule ID', 'Policy / Evidence Reference', 'Manager Sign-off', 'Open Question / Exception',
];
const documents = makeInputSheet(
  'Document Type Register',
  'One row per real record type. This is the master index: use its Document Type ID in the Workflow Rules and Governance & Retention sheets. Do not repeat detailed workflow or retention fields here.',
  documentHeaders, [20, 16, 19, 23, 28, 22, 28, 33, 19, 17, 22, 30, 23, 29, 17, 31, 28, 30, 25, 31, 27, 34, 19, 31, 21, 43], 96,
);
[
  ['Sample — replace or confirm', 'FIN', 'FIN-INVOICE', 'INVOICE', 'Invoice', 'Department', 'Procure-to-pay', 'Evidence of supplier obligation and payment', 'Record', 'External supplier / ERP', 'PDF; scan; ERP export', 'CONFIDENTIAL', 'Finance Officer', 'ERP and DMS Finance repository', 'Monthly / transaction driven', 'Supplier; invoice date; PO; amount; tax; cost centre', 'Unified approval chain', 'WF-FIN-INVOICE', 'DRAFT (SCAN_PENDING only if the file is over 100 MB)', 'Submit to approval chain', 'ACTIVE automatically once final approval clears', 'Archive after payment/reconciliation close — Records Officer', 'RET-FIN-7Y', 'Finance/tax rule to confirm', '', 'Seeded type and retention are examples only.'],
  ['Sample — replace or confirm', 'LEG', 'LEG-CONTRACT', 'CONTRACT', 'Contract', 'Global or Legal', 'Contract lifecycle', 'Binding commercial or legal agreement', 'Record', 'Internal and external', 'Word; PDF; signed scan', 'RESTRICTED', 'Legal Counsel', 'DMS Legal / contract repository', 'Event driven / amendments', 'Counterparty; effective date; expiry; value; signatories; governing law', 'Unified approval chain + e-signature ceremony', 'WF-LEG-CONTRACT', 'DRAFT (SCAN_PENDING only if the file is over 100 MB)', 'Submit to approval chain', 'ACTIVE once signing clears and audit (if configured) passes — audit is this type’s terminal clearance stage, so a Pass activates it directly, the same as an ordinary final approval; only a type with signing and no audit configured after it would land in ARCHIVED instead', 'Manually archived later at contract end-of-term/termination, same as any other ACTIVE record — Legal owns exceptions', 'RET-LEG-10Y', 'Contract policy / limitation period to confirm', '', 'Seed requires signature and a 10-year rule; confirm business authority.'],
  ['Sample — replace or confirm', 'HR', 'HR-EMPLOYEE', 'EMPLOYEE', 'Employee Record', 'Department', 'Employee lifecycle', 'Employment, performance and statutory record', 'Record', 'HR / employee / HRIS', 'PDF; scan; HRIS export', 'RESTRICTED', 'HR Officer', 'HRIS with controlled DMS record copy', 'Per employee event', 'Employee ID; record class; effective date; employment status; retention trigger', 'Approval route only for controlled classes; others publish directly', 'WF-HR-EMPLOYEE', 'DRAFT (SCAN_PENDING only if the file is over 100 MB)', 'Submit for controlled classes; owner publishes DRAFT to ACTIVE directly for others', 'ACTIVE while the record is current', 'ARCHIVED at lifecycle close — HR and Records', 'RET-HR-7Y', 'Employment / privacy authority to confirm', '', 'Split into separate types if personnel record classes have different rules.'],
  ['Sample — replace or confirm', 'PROC', 'PROC-PO', 'PO', 'Purchase Order', 'Department', 'Procure-to-pay', 'Authorised supplier commitment', 'Record', 'Internal ERP', 'ERP export; PDF', 'CONFIDENTIAL', 'Procurement Officer', 'ERP with DMS record copy', 'Per purchase order', 'PO number; supplier; value; budget owner; project; date', 'Unified approval chain', 'WF-PROC-PO', 'DRAFT (SCAN_PENDING only if the file is over 100 MB)', 'Submit to approval chain', 'ACTIVE automatically once final approval clears', 'PO closure/cancellation — Procurement Records archives', 'RET-PROC-7Y', 'Procurement authority and delegation matrix to confirm', '', 'Use approval-limit bands in Workflow Rules, not separate duplicate rows here.'],
  ['Sample — replace or confirm', 'OPS', 'OPS-WEEKLY-REPORT', 'WEEKLYRPT', 'Weekly Status Report', 'Department', 'Operations reporting', 'Routine progress visibility, no external obligation', 'Working Document', 'Internal / employee-authored', 'Word; PDF', 'INTERNAL', 'Department Employee', 'DMS Operations repository', 'Weekly, one per employee or team', 'Reporting period; author; department', 'No approval — owner publishes directly', '', 'DRAFT (SCAN_PENDING only if the file is over 100 MB)', 'Owner publishes directly — no approval required for this type', 'ACTIVE immediately on publish', 'Superseded by the next weekly report / archived at quarter end — Department Manager', 'RET-OPS-5Y', '', '', 'This is the "should this really start as Draft forever" case — confirm which report/notice types should skip approval like this one.'],
].forEach((row, index) => setRow(documents, index + 5, row, { fill: GOLD }));
addComment(documents, 'C5', 'Create a stable unique ID such as FIN-INVOICE. It links the detailed sheets and prevents repeated narrative.');
addComment(documents, 'F5', 'Global (leave the department blank/shared) means every department can use this type; Department-scoped restricts it to the owning department in column B.');
addComment(documents, 'L5', 'Must be exactly one of PUBLIC, INTERNAL, CONFIDENTIAL or RESTRICTED — the only four levels DMS enforces. There is no separate "Highly Restricted" tier.');
addComment(documents, 'P5', 'DMS captures a fixed metadata set per document (title, dates, tags, description, language, external reference, and similar) — there is no way to add a brand-new structured field per document type. If a bespoke structured field is genuinely needed, model it as a Form instead (see Forms & Correspondence).');
addComment(documents, 'Q5', 'Documents/forms use the unified approval engine. Letters/correspondence are captured separately in Forms & Correspondence.');
addComment(documents, 'R5', 'Reuse a Workflow ID when several document types — or a Form Template — share the exact same review/approval route; define its steps once in Workflow Rules.');
addComment(documents, 'S5', 'The only two entry states an upload ever gets: DRAFT for files 100 MB or smaller, or SCAN_PENDING for larger files, which the background scan then promotes to DRAFT or QUARANTINED.');
XLSX.utils.book_append_sheet(wb, documents, 'Document Type Register');

// 4. Workflow steps — decisions/review routing only; audit/signature stays on governance.
const workflowHeaders = [
  'Workflow ID', 'Applies to Document Type ID(s) / Form Template ID(s)', 'Starts When / Entry Condition', 'Stage No.',
  'Stage Type (Review / Approval — last stage must be Approval)', 'Stage Name', 'Mandatory / Locked Step?',
  'Assigned Role or Named User', 'Decision / Check Required', 'SLA (hours)',
  'If SLA Breaches — Manual Reassignment Contact', 'Outcome if Returned / Declined', 'Evidence / Notes',
];
const workflow = makeInputSheet(
  'Workflow Rules',
  'One row per review or approval stage, for a document type or a form template — both use the identical chain mechanism. Reuse a Workflow ID when several types share the same route. Audit and signature choices belong only in Governance & Retention, to avoid duplication.',
  workflowHeaders, [19, 40, 31, 10, 42, 27, 22, 29, 35, 13, 38, 32, 40], 96,
);
[
  ['WF-FIN-INVOICE', 'FIN-INVOICE', 'Owner submits DRAFT after scan clears', 1, 'Review', 'Records completeness review', 'Yes — lock if required', 'Records Officer', 'Completeness, classification and required metadata', 24, 'Records Manager — must reassign the step by hand; DMS never does it automatically', 'Bounces to submitter for correction; a fresh chain starts on resubmission', 'Illustrative stage based on the seeded route; confirm role coverage.'],
  ['WF-FIN-INVOICE', 'FIN-INVOICE', 'Stage 1 approved', 2, 'Approval', 'Manager approval', 'Yes', 'Department Manager', 'Business accuracy, budget/authority and payment readiness', 48, 'Executive Sponsor — must reassign the step by hand; DMS never does it automatically', 'Declines require a written reason; a fresh chain starts on resubmission', 'Final approval turns the document ACTIVE automatically (or routes to signing/audit first, if this type needs them).'],
  ['WF-LEG-CONTRACT', 'LEG-CONTRACT', 'Owner submits DRAFT after scan clears', 1, 'Review', 'Legal review', 'Yes', 'Legal Counsel', 'Terms, authority, obligations, privacy and risk', 48, 'General Counsel — must reassign the step by hand; DMS never does it automatically', 'Bounces to submitter for amendment; a fresh chain starts on resubmission', 'Signing follows final approval automatically when this type requires a ceremony.'],
  ['WF-LEG-CONTRACT', 'LEG-CONTRACT', 'Stage 1 approved', 2, 'Approval', 'Delegated authority approval', 'Yes', 'Delegated Executive / named approver', 'Approval within delegation limit', 24, 'Executive Sponsor / escalation matrix — must reassign the step by hand; DMS never does it automatically', 'Declines require a written reason; a fresh chain starts on resubmission', 'Use a separate Workflow ID for different value bands or legal entities.'],
  ['WF-HR-LEAVEREQUEST', 'HR-LEAVE-REQUEST-FORM', 'Employee submits a filled leave-request form', 1, 'Approval', 'Manager approval', 'Yes', 'Department Manager', 'Leave balance, coverage and dates', 24, 'HR Officer — must reassign the step by hand; DMS never does it automatically', 'Declines require a written reason; a fresh chain starts on resubmission', 'Demonstrates that a Workflow ID can govern a Form Template exactly like a document type.'],
].forEach((row, index) => setRow(workflow, index + 5, row, { fill: GOLD }));
addComment(workflow, 'E5', 'Every Workflow ID’s last stage must be an Approval step — DMS refuses to finalise a chain that ends on Review. All stages, for every Workflow ID, run strictly one at a time in the order given here; there is no parallel-step option.');
addComment(workflow, 'G5', 'DMS supports locked template steps, so the person submitting cannot remove, change or skip a mandatory control.');
addComment(workflow, 'K5', 'DMS automatically notifies the current assignee (or every holder of the assigned role) and the original submitter once, the moment a step passes its SLA — it never reassigns or escalates to anyone else by itself. Name a real person here as the manual fallback.');
XLSX.utils.book_append_sheet(wb, workflow, 'Workflow Rules');

// 5. Governance and retention — audit, signing, reapproval, retention, hold, disposal, once per type.
const governanceHeaders = [
  'Document Type ID', 'Audit Policy (Required / Optional / Never)', 'Audit Owner / Role', 'Audit Pass / Flag Requirement',
  'E-Signature Ceremony Required? (Yes/No)', 'Signatory Role(s)', 'Signing Order (Serial / Parallel)', 'Confirmed Completion Sequence',
  'Reapproval Policy (None / Major Versions / All Changes)', 'Retention Rule ID', 'Governing Authority / Legal Basis',
  'Retention Trigger', 'Trigger Date Source', 'Retention Period (years, or Permanent)', 'Hold Owner (if legal hold is applied)',
  'Archive Requirement', 'Disposal / Preservation Action', 'Disposal Authoriser(s) (System Admin / Records Officer only)',
  'Access / External Sharing Constraint', 'Evidence / Open Decision',
];
const governance = makeInputSheet(
  'Governance & Retention',
  'One row per Document Type ID. This is the only sheet for audit, e-signature, reapproval, retention, legal hold, archive, disposal and exceptional-access decisions.',
  governanceHeaders, [19, 32, 25, 30, 30, 28, 26, 36, 38, 19, 35, 24, 24, 26, 28, 21, 28, 38, 33, 45], 96,
);
[
  ['FIN-INVOICE', 'Optional — confirm', 'Internal Audit / finance control owner', 'PASS or FLAG with findings where selected', 'No — confirm', 'N/A', 'N/A', 'Approval turns it ACTIVE automatically; archived separately at business close', 'Major versions — confirm', 'RET-FIN-7Y', 'Finance / tax authority to confirm', 'Transaction date', 'ERP invoice date', '7 years — seed only', 'Legal / Compliance', 'Archive after active use — confirm', 'Certified deletion after authorised disposal', 'Records Officer + authorised approver', 'Finance; Procurement; supplier data; no public sharing', 'Confirm regulatory/tax retention, audit sampling and approval evidence.'],
  ['LEG-CONTRACT', 'Optional or required — confirm', 'Legal / designated auditor', 'PASS / FLAG and remediation route', 'Yes', 'Legal signatory; delegated executive', 'Serial — signatory then delegated executive, in that order', 'Approval, then signing, then audit if selected — a Pass on audit takes it straight to ACTIVE (DMS’s terminal clearance state), not archived; only a type with signing and no audit configured after it would land in ARCHIVED instead', 'All changes or major versions — confirm', 'RET-LEG-10Y', 'Contract policy / limitation period to confirm', 'Contract completion', 'Executed contract, termination or expiry date', '10 years — seed only', 'Legal', 'Archive final signed copy', 'Certified deletion unless an active hold or permanent exception applies', 'Records Officer + Legal', 'Restricted to Legal, owner and approved stakeholders', 'Define amendments, disputes, hold and signer delegation.'],
  ['HR-EMPLOYEE', 'Never / optional — confirm by record class', 'HR compliance owner', 'If audit applies, define finding/remediation record', 'No — confirm', 'N/A', 'N/A', 'Approval, if required, turns it ACTIVE automatically; archived after lifecycle close', 'All changes for selected classes — confirm', 'RET-HR-7Y', 'Employment, tax and privacy authority to confirm', 'Employee termination', 'HRIS termination date', '7 years after termination — seed only', 'HR + Legal', 'Controlled archive', 'Certified deletion after hold and retention checks', 'Records Officer + HR', 'Highly restricted; need-to-know and privacy controls', 'Split classes where retention/access rules differ.'],
  ['PROC-PO', 'Never / optional — confirm', 'Procurement / finance control owner', 'If audit applies, define sampling/finding action', 'No — confirm', 'N/A', 'N/A', 'Approval turns it ACTIVE automatically; archived after PO closure', 'Major versions — confirm', 'RET-PROC-7Y', 'Procurement / finance authority to confirm', 'Document date', 'ERP PO date', '7 years — seed only', 'Legal / Procurement', 'Archive after closure — confirm', 'Certified deletion after authorised disposal', 'Records Officer + Procurement', 'Supplier and financial information; controlled external distribution', 'Confirm matching, threshold and supplier dispute exceptions.'],
  ['OPS-WEEKLY-REPORT', 'Never', 'N/A', 'N/A', 'No', 'N/A', 'N/A', 'Publish turns it ACTIVE immediately; no audit or signing stage at all', 'None — any edit is free, no re-approval', 'RET-OPS-5Y', 'Internal records policy', 'Creation date', 'Report date', '5 years — seed only', 'Operations', 'Superseded weekly; archived at quarter end', 'Standard deletion after retention expires', 'Records Officer', 'Internal only', 'Shows the "mostly defaults" case — most of this row needs no real decision.'],
].forEach((row, index) => setRow(governance, index + 5, row, { fill: GOLD }));
addComment(governance, 'E5', 'DMS can route straight to a signing ceremony automatically after approval (per this type), or leave it to a manual "Send for Signature" request that anyone with signing rights can make on any already-approved document. Decide whether the ad hoc route should be restricted for this type.');
addComment(governance, 'L5', 'Only four trigger dates exist today: Archive date, the record’s own document date (e.g. a contract or invoice date), Creation date, or another transaction-type event date treated the same as creation (contract completion, employee termination, audit completion). "Case or matter closed" is not supported yet — do not select it.');
XLSX.utils.book_append_sheet(wb, governance, 'Governance & Retention');

// 6. Forms/correspondence — separate by design; one row per template (instance behaviour is entirely template-driven).
const serviceHeaders = [
  'Response Status', 'Department Code', 'Service Area (Form / Outgoing Correspondence / Incoming Correspondence)', 'Item ID',
  'Name / Class', 'Business Event / Purpose', 'Owner', 'Entry State / Intake Condition', 'Completion / Final State',
  'Lifecycle / Routing Requirement', 'Reference / Numbering Requirement', 'Response / Completion SLA',
  'Fill Triggers an Approval Chain? (Yes/No)', 'Audit Stage Policy (Required/Optional/Never)', 'E-Signature Ceremony Required? (Yes/No)',
  'Record / Retention Link', 'External Party / Dispatch Channel', 'Evidence / Open Question',
];
const service = makeInputSheet(
  'Forms & Correspondence',
  'One row per form template, incoming correspondence class or outgoing letter class. A form template’s own settings govern every instance filled from it, so template and instance are captured together, not as two rows. These items are intentionally separate from the Document Type Register because their lifecycles are different.',
  serviceHeaders, [20, 16, 34, 20, 28, 33, 22, 32, 34, 38, 28, 22, 28, 28, 28, 26, 31, 45], 76,
);
[
  ['Sample — replace or confirm', 'ALL', 'Form', 'FORM-REQ', 'Business request form', 'Capture a structured business request with attachments', 'Process owner', 'Template: DRAFT until its own approval. Instance: DRAFT if this row’s chain is Yes, otherwise ACTIVE immediately on filing', 'Template: ACTIVE after its own mandatory approval, DEPRECATED when retired. Instance: ACTIVE once filed, or once its own chain approves', 'Every new/changed template must itself be approved before use — there is no opt-out — so define that approval in Workflow Rules using this Item ID. Whether filing also starts a chain for the filled form is set in this row.', 'Template version number (automatic)', 'Business-process SLA — confirm', 'Yes — confirm', 'Optional — confirm', 'No — confirm', 'Fixed system default (RET-FORM-5Y) — not department-configurable', 'DMS portal', 'If a filled form’s chain cannot start automatically (no one currently holds the assigned role), it stays safely in Draft for someone to submit by hand from My Work — confirm who checks for this.'],
  ['Sample — replace or confirm', 'ALL', 'Outgoing Correspondence', 'LETTER-OUT', 'Official outgoing letter', 'Approved external communication', 'Correspondence owner', 'DRAFT', 'APPROVED, then DISPATCHED, then ARCHIVED', 'Draft, then review, then approval, then dispatch, then archive. The drafter assembles the review/approval chain per letter from named people or roles — it is not a pre-set admin template, so it needs no Workflow Rules row.', 'Reference number allocated automatically, only at final approval', 'Dispatch and acknowledgement SLA', 'N/A — letters use their own per-letter chain, not this engine', 'N/A — letters have no audit stage', 'N/A — a letter’s "signature" is a signatory block plus a verifiable QR code, not the e-signing ceremony', 'Correspondence retention rule', 'Email; courier; hand delivery; external recipient', 'Confirm signatory authority, dispatch evidence and the default chain roles per letter type.'],
  ['Sample — replace or confirm', 'ALL', 'Incoming Correspondence', 'LETTER-IN', 'Received letter / scanned correspondence', 'Register, route, respond, close and archive an incoming item', 'Receiving / assigned department', 'RECEIVED', 'RESPONDED or CLOSED, then ARCHIVED', 'Register, then assign/route, then respond or close, then archive. There is no approval chain on the incoming side at all.', 'Incoming reference allocated automatically at registration', 'Due-date and response SLA', 'N/A', 'N/A', 'N/A', 'Correspondence retention rule', 'Mail room; email; scan; regulator / customer', 'DMS only flags an overdue item — it never escalates or reassigns it automatically. Confirm who is responsible for checking the overdue list and acting on it.'],
].forEach((row, index) => setRow(service, index + 5, row, { fill: GOLD }));
addComment(service, 'C5', 'The Form and Correspondence lifecycles are entirely separate state machines. Letters build their own chain per letter; only Forms use a Workflow Rules row.');
addComment(service, 'O5', 'For Forms this is the same e-signing ceremony documents use. For Correspondence, DMS has no e-signing ceremony at all — a "signed" letter uses a signatory block plus QR verification instead.');
XLSX.utils.book_append_sheet(wb, service, 'Forms & Correspondence');

// 7. User roles & access — the people who actually receive DMS roles and any named exceptions.
const rolesHeaders = [
  'Response Status', 'Full Name', 'Email (DMS login identity)', 'Department(s)', 'DMS Role(s) — select all that apply',
  'Org Unit Scope (if limited to one branch/unit)', 'Named Approver / Auditor For (Document Type ID(s) or Form Template ID(s))',
  'Special Access Exception (Folder/Document + Allow or Deny + Expiry)',
  'MFA Required for This Person? (DMS supports, but never enforces, MFA — record your own policy)',
  'Manager Sign-off', 'Open Question / Evidence Needed',
];
const roles = makeInputSheet(
  'User Roles & Access Assignment',
  'One row per person who needs a DMS role or a named exception. Every role/approver/auditor named elsewhere in this workbook must resolve to a real person here before DMS can actually be configured to work.',
  rolesHeaders, [20, 24, 28, 26, 34, 30, 40, 42, 40, 21, 45], 40,
);
[
  ['Sample — replace or confirm', '(IT lead name)', 'it.lead@examplecorp.com', 'IT', 'SYSTEM_ADMIN', 'All', '', '', 'Yes — recommended for this role', '', 'Full system administration; confirm the exact name.'],
  ['Sample — replace or confirm', '(Records officer name)', 'records.officer@examplecorp.com', 'Legal', 'RECORDS_OFFICER', 'All', '', '', 'Yes — recommended for this role', '', 'Owns purge approval (maker-checker) and disposal authorisation alongside System Admin.'],
  ['Sample — replace or confirm', '(Finance department manager name)', 'fin.manager@examplecorp.com', 'Finance', 'DEPT_MANAGER', 'HQ', 'FIN-INVOICE; PROC-PO', '', 'No — confirm', '', 'One person per department is the norm; confirm if Finance needs more than one.'],
  ['Sample — replace or confirm', '(Named auditor name)', 'auditor1@examplecorp.com', 'Legal; Finance', 'AUDITOR', 'All', 'LEG-CONTRACT; FIN-INVOICE', '', 'No — confirm', '', 'An auditor can never audit an item they drafted or approved themselves — DMS enforces this automatically. List every eligible named auditor, not just one.'],
  ['Sample — replace or confirm', '(Executive name)', 'exec1@examplecorp.com', 'Executive Office', 'EXECUTIVE', 'All', '', '', 'No — confirm', '', 'Executives get read access and, optionally, letter notices per Administration & Access — they are never a chain participant themselves.'],
].forEach((row, index) => setRow(roles, index + 5, row, { fill: GOLD }));
addComment(roles, 'E5', 'A person can hold more than one role at once. The seven built-in roles are SYSTEM_ADMIN, RECORDS_OFFICER, DEPT_MANAGER, APPROVER, EMPLOYEE, AUDITOR and EXECUTIVE — a System Admin can also define additional custom roles if genuinely needed.');
addComment(roles, 'H5', 'DMS always checks a Deny before an Allow, and a grant made directly on a folder/document always wins over one inherited from its parent. Use this column only for a genuine exception to the department/role defaults above.');
XLSX.utils.book_append_sheet(wb, roles, 'User Roles & Access Assignment');

// 8. Admin/access — configuration stewardship once per control area.
const adminHeaders = [
  'Control Area', 'Scope', 'Business Owner', 'System Administrator', 'Who May Request Change?',
  'Who Approves Change?', 'Required Evidence', 'Review Cadence', 'Emergency / Exception Process', 'Open Decision / Notes',
];
const admin = makeInputSheet(
  'Administration & Access',
  'Define ownership of configuration and access changes once per control area. Do not repeat these roles on every document type unless that type has a genuine exception.',
  adminHeaders, [30, 28, 27, 28, 28, 30, 32, 20, 35, 44], 48,
);
[
  ['Document types and approval templates', 'Enterprise / department-scoped', 'Business process owner', 'DMS Administrator', 'Department Manager / process owner', 'Executive sponsor / governance owner', 'Approved document and workflow rows', 'Quarterly + on change', 'Document and approve exception; do not bypass required controls', 'Confirm which types are global versus department-specific.'],
  ['Department membership and ACL access', 'Department / individual exception', 'Department Manager + Security', 'DMS / IT Administrator', 'Department Manager', 'Department Manager; Security for restricted access', 'Access request, role, resource, expiry and justification', 'Quarterly + joiner/mover/leaver', 'Time-bound emergency access with review and expiry', 'DMS ACL permits explicit allow/deny and expiry; define exception approvers.'],
  ['Retention, legal holds and disposal', 'Enterprise', 'Records Officer + Legal', 'Records Officer / DMS Administrator', 'Records, Legal or process owner', 'Records governance / Legal', 'Governing authority, hold instruction, disposal authorisation', 'Annual + policy change', 'Active legal hold blocks ordinary lifecycle action and disposal', 'Confirm disposal segregation and certificate retention.'],
  ['Forms and correspondence configuration', 'Enterprise / department-specific', 'Form or correspondence owner', 'DMS Administrator', 'Process owner', 'Executive sponsor / communications owner', 'Approved service row, template version and authority', 'Quarterly + on change', 'Controlled emergency correspondence route / delegated signatory', 'Confirm numbering, dispatch and template-change ownership.'],
  ['Audit log retention & export access', 'Enterprise', 'Records Officer + Legal', 'DMS Administrator', 'Records or Compliance owner', 'Records governance / Legal', 'Retention-period decision; export-access policy', 'Annual', 'N/A — read-only control, nothing to bypass', 'DMS keeps every audit-log row indefinitely today and lets anyone who can view the log also export it (CSV/JSON/PDF, up to 10,000 rows). Confirm whether a retention/purge period and a stricter export-only permission are actually needed.'],
  ['Executive notification policy (letters)', 'Enterprise', 'Executive Sponsor / Comms', 'DMS Administrator', 'Executive Sponsor', 'CEO / Executive team', 'Approved letter types + confidentiality ceiling for auto-notice', 'Annual + on change', 'Any individual executive can opt out of their own notices at any time', 'Confirm which outgoing letter types (and confidentiality ceiling) should auto-email the executive group, and who if anyone is exempt.'],
  ['AI processing consent', 'Enterprise — one switch for the whole company, no per-department option', 'Data owner / Legal / IT Security', 'DMS Administrator', 'Data owner / Legal', 'Executive sponsor / Legal', 'Data-processing / compliance sign-off', 'Annual + on change', 'Off by default; leave off until sign-off is given', 'Turning this on lets any user run AI summarise/extract/chat over document content and audit data, which is sent to an external AI provider chosen by IT. Confirm whether Example Corp consents, and note it cannot be limited to one department.'],
  ['Document bundle (Stitch) exports', 'Enterprise', 'Records Officer + Legal', 'DMS Administrator', 'Any user with read access to the selected documents', 'No approval step exists today — a bundle is self-service the moment a user can read every document in it', 'None currently defined — a completed bundle produces only the standard document-read audit events, no dedicated bundle-export log line', 'Annual', 'N/A', 'This feature already exists and lets any authorised reader compile several documents’ real content into one exportable PDF, which moves content out of per-document controls. Confirm whether this needs its own approval, a dedicated audit trail, or a classification-based restriction before go-live.'],
  ['Outbound webhook subscriptions', 'Enterprise', 'IT / Integrations owner', 'DMS Administrator', 'Any user holding Operations-Manage rights', 'No approval step exists today — registering a subscription is self-service the moment a user holds Operations-Manage', 'None currently required — confirm a registration record (owning system, endpoint owner, business justification) before go-live', 'Annual', 'N/A — every target URL is SSRF-guarded (internal/loopback/metadata addresses and DNS-rebinding are rejected at registration and again at send time); nothing to bypass', 'This already exists and lets anyone holding Operations-Manage point document/workflow/retention lifecycle event notifications — metadata only (document id, type, status change), never document content — at any external URL that resolves publicly. Confirm whether registering a subscription needs its own approval step and who should be allowed to hold Operations-Manage.'],
].forEach((row, index) => setRow(admin, index + 5, row, { fill: GREEN }));
XLSX.utils.book_append_sheet(wb, admin, 'Administration & Access');

// 9. Capability guide — fixed, concise code-backed explanations so the questionnaire stays intuitive.
const dataFlow = makeGuideSheet(
  'DMS Capability Guide',
  'Code-backed guide for discussion. It describes implemented DMS capabilities and the business choices that must be confirmed; it is not an additional form to complete.',
  ['Flow', 'What DMS Does', 'Business Decision Needed', 'Evidence / Control Produced'],
  [25, 66, 60, 44],
  [
    ['Document creation', 'Stores an encrypted, versioned copy and captures a fixed metadata set (title, department, type, folder, owner, org unit, classification, dates, tags, description, language, external reference, and similar) — there are no custom per-type fields for generic documents. Files 100 MB or smaller are virus-scanned before the upload completes; larger files start as SCAN_PENDING and are scanned in the background. The background scanner is fail-open: if a scan never completes, the file is still promoted to DRAFT the same as a clean result (only flagged via an audit warning), it is not withheld or quarantined by default. Duplicate content is only ever a warning, never a block, and duplicate checking is skipped entirely on the large chunked-upload path.', 'Which fixed metadata fields are mandatory per type, allowed formats/size, confidentiality level, and whether the fail-open behaviour on an incomplete large-file scan is acceptable or should become fail-closed instead.', 'Document/version rows; scan-result and duplicate-warning audit events; encrypted storage object.'],
    ['Review and approval', 'One engine handles Documents and Forms alike: an admin-defined chain of Review/Approve steps runs strictly one at a time, in order — there is no parallel-approval option. Each step is one named person or one role; that is checked when the chain is submitted (a template can technically be saved with an unstaffed step, but submitting against it is blocked). A decision is Approve, Request Changes (bounces to the author, comment optional), or Decline (bounces to the author, comment mandatory) — either bounce lets the author resubmit as a brand-new chain. Final approval alone turns the item ACTIVE automatically only when the type needs neither signing nor audit; if either is configured the fixed order is approval, then signing, then audit. A type with signing and no audit configured after it lands in ARCHIVED once signing completes; a type with audit configured — whether or not signing ran first — goes straight to ACTIVE the moment audit Passes, the same terminal clearance as an ordinary final approval — see the Signing and Audit stage rows below.', 'Who reviews/approves each document type or form template, in what order, which steps are locked-mandatory, and the SLA hours per step.', 'Approval chain; every decision and comment, timestamped.'],
    ['Audit stage', 'For a type set to Required or Optional audit, the final approver personally names one auditor — never auto-assigned — from users who did not draft or approve this item. A Pass takes the item straight to ACTIVE — DMS treats an audit Pass as this record’s terminal clearance decision, exactly like an ordinary final approval, not a separate "archived" or "eligible to archive" state; Flag, with mandatory written findings, sends it back to that same final approver, who fixes it and restarts audit with a freshly picked auditor.', 'Which types need audit, who is eligible to audit, and what a Flag should trigger operationally.', 'Audit-stage review row; PASS/FLAG decision; independence check.'],
    ['Signing', 'A per-type setting can auto-route an approved item into a multi-recipient e-signing ceremony (internal users or emailed external parties). The sender picks Serial — one recipient at a time, enforced — or Parallel — any recipient, any time. Anyone holding signing rights can also start a ceremony ad hoc on any already-approved document, even when the type does not require one. Declines and 7-day link expiries recover automatically. Nothing is cryptographically embedded in the PDF unless an organisation signing certificate is installed — an IT deployment decision, not a business one.', 'Which types require signing, who signs and in what order, and whether the ad hoc request path should be restricted.', 'Signature request; per-recipient decision; completion timestamp.'],
    ['Versioning and reapproval', 'Every new version gets fresh encryption; nothing is overwritten. A type’s Reapproval Policy decides whether editing an already-approved item is free (None), only matters on a major version (Major Versions), or reruns approval on every single edit (All Changes) — resetting it to Draft and cancelling any signature or audit already in flight for the superseded content.', 'Reapproval policy per type; who may check out/edit.', 'Version row; reapproval reset; voided-ceremony audit events.'],
    ['Retention, legal hold and disposal', 'A retention rule’s clock starts from one of three live triggers: the archive date, the record’s own document date (e.g. a contract date), or its creation date — a "case/matter closed" trigger does not exist yet. Legal hold is a flag placeable on any document at any time, blocking trash/archive/disposal until released; it is not a separate lifecycle status, and there is no other kind of hold. A separate, unrelated background job auto-tiers archived documents with no legal hold to cold storage after 730 days of inactivity, and sends warning emails 90 and 30 days before a document becomes eligible for disposal — both run automatically, platform-wide, with no department-level configuration. Destruction always writes a permanent Certificate of Destruction record, though there is no screen yet to browse past certificates. Only System Admin/Records Officer can authorise final disposal.', 'Retention years (or Permanent), the governing policy/authority, who owns a hold, and who should hold disposal authority.', 'Retention application; legal-hold and disposal audit events; destruction certificate.'],
    ['Trash and recovery', 'Deleting anything moves it to Trash and schedules automatic permanent purge after a fixed ~30 days. In the normal trash flow this is a single window, not the two sequential stages once intended — a further 7-day "cooling" stage exists in the code but is not currently reachable from the standard trash path. A manual early purge needs two different people (the person who stages it cannot also approve it) and defaults to a separate 90-day window when used this way; the nightly automatic purge after the 30-day window expires does not need two people — it is fully system-driven.', 'Nothing to configure — the windows are fixed platform-wide (confirm whether the intended second 7-day cooling stage should actually be wired up). Only confirm who is authorised to stage/approve early purges.', 'Trash, purge-staged and purge-executed audit events.'],
    ['Forms', 'A form template must itself be approved before it can be filled — no opt-out, unlike documents — and it carries its own Audit and Signing policy, exactly like a document type, governing every form filled from it. If the template is chain-enabled, filing a form immediately submits it for approval the same way a document submission does; if that automatic submission cannot find anyone to assign it to, the filled form stays safely in Draft for someone to submit by hand from My Work. There is no recurring/scheduled form capability.', 'Which templates need a chain on fill, their audit/signing policy, and confirmation that retention is fixed platform-wide at 5 years for all forms.', 'Template version; filled instance plus its generated document; approval-warning recovery event.'],
    ['Correspondence (letters)', 'Letters run on their own, simpler engine, not the documents/forms engine: the drafter assembles an ad hoc chain of named people/roles at submission, decisions are only Approve or Return (no Decline, no audit stage), and a gap-free official reference number is stamped only at final approval. "Signed" for a letter means a signatory block plus a content-hash QR code the public can verify — a different mechanism from the e-signing ceremony documents use. Incoming mail gets a due date and an overdue flag, but nothing acts on it automatically.', 'Default review/approval roles per letter type, signatory authority, and who monitors overdue incoming mail.', 'Approval-step decisions; reference allocation; QR-verifiable PDF; dispatch/response audit events.'],
    ['Access control and roles', 'Every access decision on a document/folder follows one order: an explicit Deny always beats an explicit Allow at the same level; a grant directly on a document/folder always beats one inherited from a parent folder or department; a tenant-wide rule only ever fills a genuine gap. Separately from that ladder, an individual person can also be granted or denied one specific permission directly, on top of whatever their role(s) already give them — a per-user override at the role/permission layer, not the document layer, so it changes what that person can do everywhere, not just on one document. Seven roles ship by default (System Admin, Records Officer, Dept Manager, Approver, Employee, Auditor, Executive) and a System Admin can define more; one person can hold several roles at once. Two-factor login exists but is a self-service opt-in — no role requires it today.', 'Who gets which role(s), any named per-document/folder exceptions or per-user permission overrides, and whether roles beyond the default seven are needed.', 'ACL entries; role-permission grants; per-user permission overrides; privilege-escalation guard on every grant.'],
    ['Notifications, SLA and escalation', 'Every 15 minutes DMS checks for approval steps past their deadline and sends one breach notice to the current assignee/role-holders and the original submitter — that is the entire mechanism. It never reassigns the step and never raises it to anyone more senior, and there is no reachable delegation/out-of-office coverage anywhere in DMS today (some unused database scaffolding for it exists but nothing in the product writes to or exposes it). A person must manually reassign a stuck step. Workflow reminders, legal-hold notices and system alerts can each be turned off per user; SLA-breach mail can never be silenced.', 'If a real escalation ladder is needed (e.g. unapproved after 3 days goes to their manager), that must be a manual procedure staff follow today, not a DMS setting — decide who plays that role per workflow.', 'In-app + email breach notice, once per step.'],
    ['Search, reporting, bulk operations and AI', 'Full-text search, including scanned/OCR’d content, runs on Meilisearch; if it is ever down, search silently falls back to a title/filename-only match with no content search. Nine fixed reports plus a KPI dashboard are available — there is no custom report builder. Archive/trash/restore/move/tag/access-grant bulk actions are all available from the Files/Trash pages, each re-checking a user’s own access on every document individually — but there is no bulk import of documents/metadata. A "Bundle" export does exist, though: it compiles several selected documents’ actual decrypted content into one combined PDF with a cover page and index, which is a litigation/discovery-style export, not just a row-level register. An AI chat/summarise/extract feature exists but is switched off platform-wide until a tenant admin explicitly consents, since enabling it sends document content and audit data to an external AI provider.', 'Nothing to configure for search/reports. Confirm the AI-consent decision (see Administration & Access), and who should be allowed to compile a Bundle export and whether it needs its own approval or audit line, since it already exists and moves real document content out of individual per-document controls.', 'Search index; report exports; bulk-operation audit events; bundle-compile audit events; AI-consent flag.'],
  ],
);
XLSX.utils.book_append_sheet(wb, dataFlow, 'DMS Capability Guide');

// 10. Reference lists — static seed/configuration reference, kept separate from input.
const references = {};
const referenceBlocks = [
  ['Input labels — Response Status', 'Sample — replace or confirm', 'In progress', 'Confirmed', 'Needs executive / legal decision'],
  ['Input labels — Routing requirement', 'No approval — owner publishes directly', 'Unified approval chain', 'Unified approval chain + e-signature ceremony', 'Correspondence lifecycle (its own chain)', 'Form lifecycle (template + optional chain)'],
  ['Input labels — Audit policy', 'Required', 'Optional', 'Never'],
  ['Input labels — Reapproval policy', 'None', 'Major versions', 'All changes'],
  ['Input labels — Sensitivity / security classification', 'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'],
  ['Input labels — Retention trigger (case/matter closed is not supported)', 'Archive date', 'Document’s own date (e.g. contract/invoice date)', 'Creation date', 'Other transaction-type event date (contract completion, termination, audit completion)'],
  ['Input labels — Signing order', 'Serial (one recipient at a time, enforced)', 'Parallel (any recipient, any time)'],
  ['Seed roles (built-in) — comparison only', 'SYSTEM_ADMIN', 'RECORDS_OFFICER', 'DEPT_MANAGER', 'APPROVER', 'EMPLOYEE', 'AUDITOR', 'EXECUTIVE'],
  ['Seed org unit types — comparison only', 'HQ', 'BRANCH', 'OUTLET', 'SISTER_COMPANY'],
  ['Seed departments — comparison only', 'FIN Finance', 'HR Human Resources', 'PROC Procurement', 'LEG Legal', 'IT Information Technology', 'OPS Operations', 'EXEC Executive', 'AUDIT Audit'],
  ['Seed document types — comparison only (demo/reference tenant, 15)', 'INVOICE Invoice', 'CONTRACT Contract', 'PO Purchase Order', 'POLICY Policy', 'EMPLOYEE Employee Record', 'FILING Regulatory Filing', 'REPORT Report', 'SOP Standard Operating Procedure', 'AUDIT Audit Report', 'INCIDENT Incident Report', 'PLAN Strategic Plan', 'BOARD Board Minutes', 'CHANGE Change Request', 'AGREEMENT Agreement', 'RECEIPT Receipt'],
  ['System-default document type codes — auto-provisioned for every tenant at creation (4, not department-facing)', 'FORM Generated Form', 'CORR Correspondence', 'BUNDLE Compiled Document Bundle', 'SIGN-UNCAT Uncategorized Signed Document'],
  ['Seed retention classes — comparison only (demo/reference tenant, 11)', 'RET-FIN-7Y', 'RET-LEG-10Y', 'RET-PROC-7Y', 'RET-CORP-PERM', 'RET-HR-7Y', 'RET-CORP-5Y', 'RET-OPS-5Y', 'RET-AUDIT-7Y', 'RET-IT-3Y', 'RET-LEGAL-HOLD', 'RET-OPS-PERM-ACTIVE'],
  ['System-default retention classes — auto-provisioned for every tenant at creation (4)', 'RET-FORM-5Y', 'RET-CORR-5Y', 'RET-BUNDLE-5Y', 'RET-UNCAT-5Y'],
];
let referenceRow = 1;
for (const values of referenceBlocks) {
  setRow(references, referenceRow, values, { fill: referenceRow % 4 === 1 ? BLUE : GREY, bold: true });
  referenceRow += 2;
}
references['!ref'] = `A1:P${referenceRow}`;
references['!cols'] = Array.from({ length: 16 }, () => ({ wch: 28 }));
references['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
XLSX.utils.book_append_sheet(wb, references, 'Reference Lists');

await fs.mkdir(outputDir, { recursive: true });
XLSX.writeFile(wb, outputPath, { bookType: 'xlsx', cellStyles: true });
console.log(outputPath);
