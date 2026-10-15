# Shared components

Cross-feature UI. Anything used by exactly one feature belongs in that feature's
folder under `features/`, not here.

Props are exported TypeScript interfaces — read the component for the full API.
This file records what exists and the conventions that are not obvious from the
types.

## What is here

| Component | Use it for |
|---|---|
| `DataTable` | Every tabular list. Generic over the row type; `columns[].render` for custom cells, `keyExtractor` for React keys, `onRowClick` for navigation. Renders its own empty state, and collapses to cards on small screens. |
| `Modal`, `ModalFooter` | Dialogs. Backdrop click and ESC close it, body scroll locks while open, sizes `sm`/`md`/`lg`/`xl`. |
| `DocumentPreviewModal` | In-place document preview (PDF, images, text). |
| `DocumentMultiPicker` | Selecting several documents — bundles, e-sign, legal hold. |
| `PermissionGate` | Conditional rendering by permission. **Gate on permissions, never on role names** — DMS has no fixed role taxonomy, so `role === 'ADMIN'` is always a bug. |
| `AuthGuard` | Route-level authentication + tenant-selection guard. |
| `ErrorBoundary` | Catches render errors so one broken panel does not blank the page. |
| `Sidebar`, `TopBar`, `PageHeader`, `HierarchyBreadcrumb` | Application chrome and navigation. |
| `CommandPalette` | Ctrl/Cmd-K global navigation and actions. |
| `TenantSwitcher`, `ThemeSwitcher`, `Avatar` | Identity and appearance controls. |
| `EmptyState` | The "nothing here yet" placeholder, with an optional call to action. |
| `Badge`, `StatCard`, `FileTypeIcon` | Small presentational pieces. |
| `AssignmentAdvisoryNotice` | Surfaces the assignment-advisory hint on approval and letter forms. |
| `InstallAppButton`, `ServiceWorkerRegistration` | PWA install prompt and service-worker lifecycle. |
| `ui/MetricCard`, `ui/PaginationControls`, `ui/SkeletonRow`, `ui/StatusBadge` | Lower-level primitives composed by the components above. |

## Conventions

- **Dark mode is not optional.** Every component styles both themes with
  Tailwind `dark:` variants. A component that looks right in only one theme is
  unfinished.
- **Export the props interface.** Callers type against it; several features
  build wrapper components on top.
- **Stay generic.** If a component needs to know about documents *and* letters
  *and* forms, it probably belongs to a feature instead.
- **Keep this table in step.** It is short on purpose — a component catalogue
  with usage examples for every prop drifts out of date faster than it helps,
  which is exactly what happened to the previous version of this file.
