import { test, expect, expectPageHealthy, watchConsole } from './fixtures/app';
import { apiLogin, apiGetCached as apiGet, createDraftDocument, type ApiSession } from './fixtures/api';

/**
 * Documents (DMS core): the repository, a document's detail page, and its
 * approval-chain editor.
 *
 * WHY THE CHAIN EDITOR IS ASSERTED HERE
 *
 * The forms fill dialog and this page now render the SAME editor component
 * (features/approvals/ApprovalStepsEditor). It was extracted from this page in
 * order to give forms an approver picker without writing a second
 * implementation of rules the engine enforces once. This spec is the guard on
 * that extraction: it proves the document side still offers everything it did
 * before — per-step REVIEW/APPROVE, a department-scoped role, a tenant-global
 * named person, and add/remove.
 *
 * The Workflow tab is also where a real reported bug landed: a named approver
 * from another department was assigned successfully, saw the item in My Work,
 * and then got AUTHZ_ACL_NO_ENTRY on their first click — because the page loads
 * GET /documents/:id before the tab renders, and that had no chain-participant
 * bypass. That is covered end-to-end by
 * test-scripts/verify-approval-participant-access.ts as two real users over
 * HTTP; what this adds is that the page a victim of it would open actually
 * renders.
 */

let api: ApiSession;
let sampleDocumentId: string | null = null;

test.beforeAll(async () => {
  api = await apiLogin();
  const documents = await apiGet(api, '/documents?take=5');
  sampleDocumentId = documents.data?.[0]?.id ?? null;
});

test.describe('documents: the repository', () => {
  test('the document list renders with real rows', async ({ page }) => {
    const consoleWatcher = watchConsole(page);

    await page.goto('/dashboard/documents');
    await expectPageHealthy(page);
    await expect(page.getByRole('heading', { level: 1, name: /^All Documents$/ })).toBeVisible();

    const total = (await apiGet(api, '/documents?take=1')).total ?? 0;
    if (total > 0) {
      // The API says there are documents, so the table must show some. Asserted
      // on the table itself rather than on any text — the sidebar carries a
      // "Documents" nav heading that stays in the DOM while hidden, and matching
      // that proves nothing about whether the page rendered its rows.
      await expect(page.locator('table tbody tr').first()).toBeVisible();
    }

    expect(consoleWatcher.errors, consoleWatcher.errors.join('\n')).toEqual([]);
  });

  test('a document detail page opens without a client-side crash', async ({ page }) => {
    test.skip(!sampleDocumentId, 'no documents exist in this environment');
    const consoleWatcher = watchConsole(page);

    await page.goto(`/dashboard/documents/${sampleDocumentId}`);
    await expectPageHealthy(page);

    // The page that died first when a cross-department approver clicked their
    // own assigned work.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('main')).toBeVisible();

    expect(consoleWatcher.errors, consoleWatcher.errors.join('\n')).toEqual([]);
  });
});

test.describe('documents: the approval chain editor', () => {
  test('the workflow view renders for a document', async ({ page }) => {
    test.skip(!sampleDocumentId, 'no documents exist in this environment');
    const consoleWatcher = watchConsole(page);

    await page.goto(`/dashboard/documents/${sampleDocumentId}?tab=workflow`);
    await expectPageHealthy(page);

    // Whatever the document's state, the workflow area must render something
    // about approval rather than an error boundary — a blank Workflow tab is
    // how the ACL bug presented to the person it hit.
    await expect(page.getByText(/approval|workflow|not submitted|submit for approval/i).first()).toBeVisible();

    expect(consoleWatcher.errors, consoleWatcher.errors.join('\n')).toEqual([]);
  });

  test('a draft document offers the full step editor, unchanged by the forms extraction', async ({ page }) => {
    // Uploaded here rather than found: a spec that SKIPS when no draft happens
    // to exist would go quiet exactly when a regression in the extracted editor
    // would ship.
    const draft = await createDraftDocument(api, { title: `E2E draft doc ${Date.now()}` });

    await page.goto(`/dashboard/documents/${draft.id}?tab=workflow`);
    await expectPageHealthy(page);

    // Awaited, not probed with isVisible(): that is an immediate check with no
    // retry, so on a page still loading it silently SKIPPED this test — the
    // failure mode a skip is supposed to prevent.
    const submitButton = page.getByRole('button', { name: /Submit for approval/i }).first();
    await expect(
      submitButton,
      'a freshly uploaded DRAFT document offers no submit action',
    ).toBeVisible();
    await submitButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Everything the shared editor must still provide on the documents side.
    await expect(dialog.getByTestId('approval-step-0-type')).toBeVisible();
    await expect(dialog.getByTestId('approval-step-0-role')).toBeVisible();
    await expect(dialog.getByTestId('approval-step-0-user')).toBeVisible();
    await expect(dialog.getByTestId('approval-step-add')).toBeVisible();

    // Add and remove must both still work — the extraction moved this state
    // handling behind a callback, and a broken `onChange` would leave the list
    // frozen while still looking correct.
    const stepsBefore = await dialog.getByTestId(/^approval-step-\d+-type$/).count();
    await dialog.getByTestId('approval-step-add').click();
    await expect(dialog.getByTestId(/^approval-step-\d+-type$/)).toHaveCount(stepsBefore + 1);

    await dialog.getByRole('button', { name: 'Remove step' }).last().click();
    await expect(dialog.getByTestId(/^approval-step-\d+-type$/)).toHaveCount(stepsBefore);
  });
});
