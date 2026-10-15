'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { TopBar } from '../../shared/components/TopBar';
import { useUIStore } from '../../state/ui.store';
import {
  Shield,
  Settings,
  FileStack,
  Users,
  Activity,
  Database,
  Globe,
  Building2,
  FolderTree,
  ClipboardList,
  Archive,
  Gavel,
  LayoutDashboard,
  BarChart3,
  KeyRound,
  Cpu,
  AlertTriangle,
  Bot,
} from 'lucide-react';

import dynamic from 'next/dynamic';
import { useAuthStore } from '../../state/auth.store';
import { formatTenantName } from '../../shared/lib/tenant';

// Every panel below is one tab of this page — only `activePanel`'s panel is
// ever mounted at a time (see the `activePanel === 'x' &&` render block), so
// dynamic()+ssr:false keeps the other 24 panels' code out of the route's
// initial bundle instead of shipping all of them (505 kB First Load JS)
// on every visit regardless of which tab, if any, gets opened. Same
// pattern already used for the recharts widgets on the Reports page.
const SystemHealthPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.SystemHealthPanel), { ssr: false });
const UsersPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.UsersPanel), { ssr: false });
const OutboxPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.OutboxPanel), { ssr: false });
const WebhooksPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.WebhooksPanel), { ssr: false });
const CryptoStatusPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.CryptoStatusPanel), { ssr: false });
const AntivirusPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.AntivirusPanel), { ssr: false });
const FeatureFlagsPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.FeatureFlagsPanel), { ssr: false });
const PipelinePanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.PipelinePanel), { ssr: false });
const SystemErrorsPanel = dynamic(() => import('../../features/operations/SystemPanels').then((m) => m.SystemErrorsPanel), { ssr: false });
const AuditLogPanel = dynamic(() => import('../../features/operations/AuditPanels').then((m) => m.AuditLogPanel), { ssr: false });
const IntegrityVerificationPanel = dynamic(() => import('../../features/operations/AuditPanels').then((m) => m.IntegrityVerificationPanel), { ssr: false });
const TenantsCrudPanel = dynamic(() => import('../../features/admin/crudPanels').then((m) => m.TenantsCrudPanel), { ssr: false });
const DepartmentsCrudPanel = dynamic(() => import('../../features/admin/crudPanels').then((m) => m.DepartmentsCrudPanel), { ssr: false });
const FoldersCrudPanel = dynamic(() => import('../../features/admin/crudPanels').then((m) => m.FoldersCrudPanel), { ssr: false });
const DocumentTypesCrudPanel = dynamic(() => import('../../features/admin/crudPanels').then((m) => m.DocumentTypesCrudPanel), { ssr: false });
const OrgUnitsPanel = dynamic(() => import('../../features/admin/OrgUnitsPanel').then((m) => m.OrgUnitsPanel), { ssr: false });
const WorkflowTasksPanel = dynamic(() => import('../../features/operations/WorkflowPanels').then((m) => m.WorkflowTasksPanel), { ssr: false });
const WorkflowDefinitionsPanel = dynamic(() => import('../../features/operations/WorkflowDefinitionsPanel').then((m) => m.WorkflowDefinitionsPanel), { ssr: false });
const ApprovalChainsPanel = dynamic(() => import('../../features/operations/ApprovalChainsPanel').then((m) => m.ApprovalChainsPanel), { ssr: false });
const RecordsLifecyclePanel = dynamic(() => import('../../features/operations/RecordsPanels').then((m) => m.RecordsLifecyclePanel), { ssr: false });
const OcrReviewPanel = dynamic(() => import('../../features/operations/RecordsPanels').then((m) => m.OcrReviewPanel), { ssr: false });
const ManagerHubPanel = dynamic(() => import('../../features/operations/ManagerHubPanel').then((m) => m.ManagerHubPanel), { ssr: false });
const HierarchyTreeBrowser = dynamic(() => import('../../features/hierarchy/HierarchyTreeBrowser').then((m) => m.HierarchyTreeBrowser), { ssr: false });
const AccessControlCenter = dynamic(() => import('../../features/access-control/AccessControlCenter').then((m) => m.AccessControlCenter), { ssr: false });
const RoleEditor = dynamic(() => import('../../features/roles/RoleEditor').then((m) => m.RoleEditor), { ssr: false });
const RolesList = dynamic(() => import('../../features/roles/RolesList').then((m) => m.RolesList), { ssr: false });
const RetentionConsole = dynamic(() => import('../../features/retention/RetentionConsole').then((m) => m.RetentionConsole), { ssr: false });
const LegalHoldConsole = dynamic(() => import('../../features/legal-hold/LegalHoldConsole').then((m) => m.LegalHoldConsole), { ssr: false });
const ComplianceReportsPanel = dynamic(() => import('../../features/operations/ComplianceReportsPanel').then((m) => m.ComplianceReportsPanel), { ssr: false });
const WorkflowInstancesPanel = dynamic(() => import('../../features/operations/WorkflowInstancesPanel').then((m) => m.WorkflowInstancesPanel), { ssr: false });
const AiControlsPanel = dynamic(() => import('../../features/operations/AiControlsPanel').then((m) => m.AiControlsPanel), { ssr: false });
const IdpRoleMappingsPanel = dynamic(() => import('../../features/operations/IdpRoleMappingsPanel').then((m) => m.IdpRoleMappingsPanel), { ssr: false });

type Panel =
  | 'audit'
  | 'approvalChains'
  | 'integrity'
  | 'users'
  | 'docTypes'
  | 'departments'
  | 'folders'
  | 'tenants'
  | 'health'
  | 'pipeline'
  | 'systemErrors'
  | 'outbox'
  | 'webhooks'
  | 'workflows'
  | 'workflowDefs'
  | 'lifecycle'
  | 'legalHold'
  | 'retentionPolicies'
  | 'ocr'
  | 'manager'
  | 'hierarchy'
  | 'accessControl'
  | 'roles'
  | 'orgUnits'
  | 'reports'
  | 'cryptoStatus'
  | 'antivirus'
  | 'featureFlags'
  | 'workflowInstances'
  | 'idpRoleMappings'
  | 'aiControls';

type PanelConfig = {
  key: Panel;
  label: string;
  icon: any;
  description: string;
  permission: string;
};

const panelConfigs: PanelConfig[] = [
  // Department Management
  {
    key: 'manager',
    label: 'Manager Hub',
    icon: LayoutDashboard,
    description: 'Department management and approvals',
    permission: PERMISSIONS.DEPT_MANAGE,
  },
  
  // Compliance Reporting
  {
    key: 'reports',
    label: 'Compliance Reports',
    icon: BarChart3,
    description: 'Run and export compliance reports',
    permission: PERMISSIONS.AUDIT_READ,
  },

  // Audit & Security
  {
    key: 'audit',
    label: 'Audit Logs',
    icon: Shield,
    description: 'Hash-chained security audit trail',
    permission: PERMISSIONS.AUDIT_READ,
  },
  {
    key: 'integrity',
    label: 'Chain Integrity',
    icon: Shield,
    description: 'Verify audit log integrity',
    permission: PERMISSIONS.AUDIT_READ,
  },
  
  // User & Access Management
  {
    key: 'users',
    label: 'Users',
    icon: Users,
    description: 'Manage user accounts and roles',
    permission: PERMISSIONS.USER_MANAGE,
  },
  // Phase 4: Task 4.3 - Wire RoleEditor
  {
    key: 'roles',
    label: 'Role Editor',
    icon: Shield,
    description: 'Configure role permissions',
    permission: PERMISSIONS.ROLE_MANAGE,
  },
  // Phase 4: Task 4.2 - Wire AccessControlCenter
  {
    key: 'accessControl',
    label: 'Access Control',
    icon: Shield,
    description: 'Grant and manage access permissions',
    permission: PERMISSIONS.ACL_MANAGE,
  },
  
  // Configuration & Settings
  {
    key: 'tenants',
    label: 'Tenants',
    icon: Globe,
    description: 'Multi-tenant isolation and quotas',
    permission: PERMISSIONS.TENANT_READ,
  },
  {
    key: 'orgUnits',
    label: 'Organization',
    icon: Building2,
    description: 'HQ, branches, outlets & sister companies — the parent of departments',
    permission: PERMISSIONS.ORG_UNIT_READ,
  },
  {
    key: 'departments',
    label: 'Departments',
    icon: Building2,
    description: 'Organizational departments',
    permission: PERMISSIONS.DEPT_READ,
  },
  // Phase 4: Task 4.1 - Wire HierarchyTreeBrowser
  {
    key: 'hierarchy',
    label: 'Hierarchy Browser',
    icon: FolderTree,
    description: 'Visual hierarchy tree browser',
    permission: PERMISSIONS.DEPT_READ,
  },
  {
    key: 'folders',
    label: 'Folders',
    icon: FolderTree,
    description: 'Repository folder hierarchy',
    permission: PERMISSIONS.FOLDER_READ,
  },
  {
    key: 'docTypes',
    label: 'Document Types',
    icon: FileStack,
    description: 'Document classification types',
    permission: PERMISSIONS.DOCTYPE_READ,
  },
  
  // Workflow & Approvals
  {
    key: 'workflows',
    label: 'Workflow Queue',
    icon: ClipboardList,
    description: 'Pending approval tasks',
    permission: PERMISSIONS.WORKFLOW_APPROVE,
  },
  {
    key: 'workflowDefs',
    label: 'Workflow Definitions',
    icon: ClipboardList,
    description: 'Configure approval stages, SLA hours, and approver roles',
    permission: PERMISSIONS.WORKFLOW_MANAGE,
  },
  {
    key: 'approvalChains',
    label: 'Approval Chains',
    icon: ClipboardList,
    description: 'Chain templates per document type + the audit-stage register',
    permission: PERMISSIONS.WORKFLOW_MANAGE,
  },
  {
    key: 'workflowInstances',
    label: 'Workflow Instances',
    icon: ClipboardList,
    description: 'Every workflow instance across the tenant, not just tasks assigned to you',
    permission: PERMISSIONS.PLATFORM_ADMIN,
  },
  {
    key: 'aiControls',
    label: 'AI Controls',
    icon: Bot,
    description: 'What may be sent to AI, for whom, how often, and who used it',
    permission: PERMISSIONS.AI_MANAGE,
  },
  {
    key: 'idpRoleMappings',
    label: 'AD Group Mappings',
    icon: KeyRound,
    description: 'Read-only view of the ad_group_dn -> role fallback (managed from the SSO console)',
    permission: PERMISSIONS.PLATFORM_ADMIN,
  },

  // Records Management
  {
    key: 'lifecycle',
    label: 'Lifecycle Queue',
    icon: Archive,
    description: 'Document lifecycle management',
    permission: PERMISSIONS.RETENTION_MANAGE,
  },
  // Phase 7: Task 7.1 - Wire RetentionConsole
  {
    key: 'retentionPolicies',
    label: 'Retention Policies',
    icon: Archive,
    description: 'Configure retention policies',
    permission: PERMISSIONS.RETENTION_MANAGE,
  },
  // Phase 7: Task 7.2 - Wire LegalHoldConsole
  {
    key: 'legalHold',
    label: 'Legal Holds',
    icon: Gavel,
    description: 'Manage legal holds on documents',
    permission: PERMISSIONS.LEGAL_HOLD_MANAGE,
  },
  {
    key: 'ocr',
    label: 'OCR Review',
    icon: Activity,
    description: 'Review low-confidence OCR results',
    permission: PERMISSIONS.RETENTION_MANAGE,
  },
  
  // System Operations
  {
    key: 'health',
    label: 'System Health',
    icon: Activity,
    description: 'Live infrastructure status',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'pipeline',
    label: 'Pipeline Observability',
    icon: BarChart3,
    description: 'OCR/AI job counts, outcomes, and durations',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'systemErrors',
    label: 'System Errors',
    icon: AlertTriangle,
    description: 'Unhandled 500s, whether they actually alerted anyone, and a test-alert button',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'outbox',
    label: 'Outbox Queue',
    icon: Database,
    description: 'Background task processor',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'webhooks',
    label: 'Webhooks',
    icon: Globe,
    description: 'Outbound webhook subscriptions',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'antivirus',
    label: 'Antivirus / Scanning',
    icon: Shield,
    description: 'ClamAV daemon status and how much of the archive was actually scanned',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'cryptoStatus',
    label: 'Crypto / KEK Status',
    icon: KeyRound,
    description: 'Encryption key rotation visibility for document DEKs',
    permission: PERMISSIONS.OPERATIONS_MANAGE,
  },
  {
    key: 'featureFlags',
    label: 'Feature Flags',
    icon: Cpu,
    description: 'Per-tenant switches (e.g. the AI processing consent gate)',
    permission: PERMISSIONS.TENANT_MANAGE,
  },
];

export default function OperationsPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { can } = usePermissions();
  const tenantName = formatTenantName(useAuthStore((s) => s.tenantId));
  const searchParams = useSearchParams();
  const panelParam = searchParams.get('panel');
  const [selectedRoleId, setSelectedRoleId] = useState<string | undefined>(undefined);

  // Filter panels based on user permissions
  const availablePanels = panelConfigs.filter((panel) => can(panel.permission));

  // Derived, not state. Every tab on this page is a Sidebar link to
  // /operations?panel=<key>, so the query param is the only thing that ever
  // selects a panel — nothing else called setActivePanel. Mirroring the URL
  // into state through an effect just cost an extra render on every navigation
  // (and react-hooks/set-state-in-effect rejects it under eslint-config-next
  // 16). An unrecognised or absent ?panel falls back to the first panel the
  // user is allowed to see, exactly as before.
  const activePanel: Panel | null =
    panelParam && availablePanels.some((p) => p.key === panelParam)
      ? (panelParam as Panel)
      : (availablePanels[0]?.key ?? null);

  // If user has no permissions for any panel
  if (availablePanels.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0 flex items-center justify-center">
        <div className="ui-empty">
          <div
            className="flex items-center justify-center rounded-xl mb-4"
            style={{ width: 56, height: 56, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}
          >
            <Shield className="h-6 w-6" style={{ color: 'var(--danger)' }} />
          </div>
          <p className="ui-empty-title">Access Restricted</p>
          <p className="ui-empty-desc">You don&apos;t have permission to access any operations panels.</p>
        </div>
      </div>
    );
  }

  const activePanelConfig = panelConfigs.find((p) => p.key === activePanel);

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <TopBar
        title="Operations"
        breadcrumbs={[{ label: 'Operations' }]}
        onMobileMenuToggle={toggleSidebar}
      />

      <div className="p-6 max-w-7xl mx-auto w-full animate-fade-up">
      <div className="mb-6">
        <h1 className="page-title">Operations Center</h1>
        <p className="page-subtitle">
          System administration, security monitoring, and governance operations.
        </p>
      </div>

      {/* Panel Content — panel switching now lives in the sidebar's Operations dropdown */}
      <div className="ui-card overflow-hidden">
        {activePanelConfig && (
          <div
            className="px-5 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <div
              className="flex items-center justify-center rounded-lg shrink-0"
              style={{
                width: 32,
                height: 32,
                background: 'rgba(99,102,241,0.1)',
                border: '1px solid rgba(99,102,241,0.2)',
              }}
            >
              <activePanelConfig.icon className="h-4 w-4" style={{ color: 'var(--brand-600)' }} />
            </div>
            <div>
              <h2
                className="text-[14px] font-semibold leading-none"
                style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}
              >
                {activePanelConfig.label}
              </h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {activePanelConfig.description}
              </p>
            </div>
          </div>
        )}

        <div className="p-5">
          {/* Department Management */}
          {activePanel === 'manager' && (
            <PermissionGate permission={PERMISSIONS.DEPT_MANAGE}>
              <ManagerHubPanel />
            </PermissionGate>
          )}

          {/* Compliance Reporting */}
          {activePanel === 'reports' && (
            <PermissionGate permission={PERMISSIONS.AUDIT_READ}>
              <ComplianceReportsPanel />
            </PermissionGate>
          )}

          {/* Audit & Security Panels */}
          {activePanel === 'audit' && (
            <PermissionGate permission={PERMISSIONS.AUDIT_READ}>
              <AuditLogPanel />
            </PermissionGate>
          )}
          
          {activePanel === 'integrity' && (
            <PermissionGate permission={PERMISSIONS.AUDIT_READ}>
              <IntegrityVerificationPanel />
            </PermissionGate>
          )}

          {/* User Management */}
          {activePanel === 'users' && (
            <PermissionGate permission={PERMISSIONS.USER_MANAGE}>
              <UsersPanel />
            </PermissionGate>
          )}
          
          {/* Phase 4: Task 4.3 - RoleEditor */}
          {activePanel === 'roles' && (
            <PermissionGate permission={PERMISSIONS.ROLE_MANAGE}>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
                  <RolesList selectedRoleId={selectedRoleId} onSelect={setSelectedRoleId} />
                </div>
                {/* FIX (platform audit finding 2026-08-14): RoleEditor's
                    Cancel button called onCancel?.(), but this was the only
                    call site and passed neither onSave nor onCancel — the
                    button was a complete no-op. Wired to deselect the role,
                    returning to the "Select a role to edit permissions"
                    placeholder, same as if nothing had been chosen yet. */}
                <RoleEditor roleId={selectedRoleId} onCancel={() => setSelectedRoleId(undefined)} />
              </div>
            </PermissionGate>
          )}
          
          {/* Phase 4: Task 4.2 - AccessControlCenter */}
          {activePanel === 'accessControl' && (
            <PermissionGate permission={PERMISSIONS.ACL_MANAGE}>
              <AccessControlCenter
                preselectedResource={
                  searchParams.get('resource') && searchParams.get('id')
                    ? { type: String(searchParams.get('resource')), id: String(searchParams.get('id')) }
                    : undefined
                }
              />
            </PermissionGate>
          )}

          {/* Configuration Panels */}
          {activePanel === 'tenants' && (
            <PermissionGate permission={PERMISSIONS.TENANT_READ}>
              <TenantsCrudPanel />
            </PermissionGate>
          )}

          {activePanel === 'orgUnits' && (
            <PermissionGate permission={PERMISSIONS.ORG_UNIT_READ}>
              <OrgUnitsPanel />
            </PermissionGate>
          )}

          {activePanel === 'departments' && (
            <PermissionGate permission={PERMISSIONS.DEPT_READ}>
              <DepartmentsCrudPanel />
            </PermissionGate>
          )}
          
          {/* Phase 4: Task 4.1 - HierarchyTreeBrowser */}
          {activePanel === 'hierarchy' && (
            <PermissionGate permission={PERMISSIONS.DEPT_READ}>
              <HierarchyTreeBrowser tenantName={tenantName} />
            </PermissionGate>
          )}

          {activePanel === 'folders' && (
            <PermissionGate permission={PERMISSIONS.FOLDER_READ}>
              <FoldersCrudPanel />
            </PermissionGate>
          )}

          {activePanel === 'docTypes' && (
            <PermissionGate permission={PERMISSIONS.DOCTYPE_READ}>
              <DocumentTypesCrudPanel />
            </PermissionGate>
          )}

          {/* Workflow & Approvals */}
          {activePanel === 'workflows' && (
            <PermissionGate permission={PERMISSIONS.WORKFLOW_APPROVE}>
              <WorkflowTasksPanel />
            </PermissionGate>
          )}

          {activePanel === 'workflowDefs' && (
            <PermissionGate permission={PERMISSIONS.WORKFLOW_MANAGE}>
              <WorkflowDefinitionsPanel />
            </PermissionGate>
          )}

          {activePanel === 'approvalChains' && (
            <PermissionGate permission={PERMISSIONS.WORKFLOW_MANAGE}>
              <ApprovalChainsPanel />
            </PermissionGate>
          )}

          {activePanel === 'workflowInstances' && (
            <PermissionGate permission={PERMISSIONS.PLATFORM_ADMIN}>
              <WorkflowInstancesPanel />
            </PermissionGate>
          )}

          {activePanel === 'aiControls' && (
            <PermissionGate permission={PERMISSIONS.AI_MANAGE}>
              <AiControlsPanel />
            </PermissionGate>
          )}

          {activePanel === 'idpRoleMappings' && (
            <PermissionGate permission={PERMISSIONS.PLATFORM_ADMIN}>
              <IdpRoleMappingsPanel />
            </PermissionGate>
          )}

          {/* Records Management */}
          {activePanel === 'lifecycle' && (
            <PermissionGate permission={PERMISSIONS.RETENTION_MANAGE}>
              <RecordsLifecyclePanel />
            </PermissionGate>
          )}
          
          {/* Phase 7: Task 7.1 - RetentionConsole */}
          {activePanel === 'retentionPolicies' && (
            <PermissionGate permission={PERMISSIONS.RETENTION_MANAGE}>
              <RetentionConsole />
            </PermissionGate>
          )}
          
          {/* Phase 7: Task 7.2 - LegalHoldConsole */}
          {activePanel === 'legalHold' && (
            <PermissionGate permission={PERMISSIONS.LEGAL_HOLD_MANAGE}>
              <LegalHoldConsole />
            </PermissionGate>
          )}

          {activePanel === 'ocr' && (
            <PermissionGate permission={PERMISSIONS.RETENTION_MANAGE}>
              <OcrReviewPanel />
            </PermissionGate>
          )}

          {/* System Operations */}
          {activePanel === 'health' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <SystemHealthPanel />
            </PermissionGate>
          )}

          {activePanel === 'pipeline' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <PipelinePanel />
            </PermissionGate>
          )}

          {activePanel === 'systemErrors' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <SystemErrorsPanel />
            </PermissionGate>
          )}

          {activePanel === 'outbox' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <OutboxPanel />
            </PermissionGate>
          )}

          {activePanel === 'webhooks' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <WebhooksPanel />
            </PermissionGate>
          )}

          {activePanel === 'antivirus' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <AntivirusPanel />
            </PermissionGate>
          )}

          {activePanel === 'cryptoStatus' && (
            <PermissionGate permission={PERMISSIONS.OPERATIONS_MANAGE}>
              <CryptoStatusPanel />
            </PermissionGate>
          )}

          {activePanel === 'featureFlags' && (
            <PermissionGate permission={PERMISSIONS.TENANT_MANAGE}>
              <FeatureFlagsPanel />
            </PermissionGate>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
