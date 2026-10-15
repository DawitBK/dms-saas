import { test, expect, expectPageHealthy } from './fixtures/app';
import { apiLogin, apiGet, apiGetCached, apiPost, APPROVER_EMAIL, type ApiSession } from './fixtures/api';
import type { Page } from '@playwright/test';

/**
 * Letters (CAMS): "submit for approval" and "initiate signing" are two
 * different actions, and neither implies the other.
 *
 * WHAT WAS WRONG
 *
 * They were fused. One dialog asked for the approval chain AND "who signs this
 * letter", and the signing ceremony was created as a SIDE EFFECT of the final
 * approval (inside decideStep). So the person chosen as signatory received an
 * approval task, not a signature request — the reported symptom was exactly
 * that: "sending for signing is received by the signer as an approval request".
 * There was no "Initiate signing" action on a letter at all.
 *
 * WHAT IT IS NOW
 *
 *   Submit for approval → approvers only.
 *   Final approval      → APPROVED. No reference number, no document, no
 *                         ceremony. Nothing is dispatchable yet, because there
 *                         is no letter of record.
 *   Initiate signing    → its own action and its own dialog, where the
 *                         signatory is chosen explicitly. A NAMED person is
 *                         tenant-global; a ROLE is department-scoped.
 *
 * The reference number is allocated at SIGNATURE, gap-free and irreversible,
 * which is why the order matters and why "approved but unsigned" must not offer
 * dispatch — it would be dispatching a letter that has no number.
 */

let api: ApiSession;
let approverApi: ApiSession;

/** HQ + its Finance department. The QA tenant has a second "FIN" in the North branch, so the code alone is ambiguous. */
async function hqFinance() {
  const orgUnits = (await apiGetCached(api, '/org-units')).data;
  const departments = (await apiGetCached(api, '/departments')).data;
  const orgUnit = orgUnits.find((o: any) => o.code === 'HQ') ?? orgUnits[0];
  const department = departments.find((d: any) => d.code === 'FIN' && d.orgUnitId === orgUnit.id) ?? departments.find((d: any) => d.orgUnitId === orgUnit.id);
  return { orgUnit, department };
}

/** A composed outgoing letter, approved and waiting for signing to be started. */
async function approvedLetter(subject: string): Promise<any> {
  // Cached: these do not change during a run, and re-fetching them per letter
  // spends the shared per-user request budget on nothing.
  const { orgUnit, department } = await hqFinance();

  const letter = (
    await apiPost(api, '/letters', {
      orgUnitId: orgUnit.id,
      departmentId: department.id,
      subject,
      bodyHtml: '<p>E2E body</p>',
      letterType: 'OUT',
      correspondent: 'E2E Correspondent',
      correspondentEmail: 'e2e@example.com',
    })
  ).data;

  // Approvers only — the submit call no longer carries a signatory at all.
  const submitted = (
    await apiPost(api, `/letters/${letter.id}/submit`, {
      steps: [{ stepType: 'APPROVE', assignedUserId: approverApi.user.id }],
    })
  ).data;

  // `approvalSteps`, not `steps` — the letters payload names it that way, and a
  // wrong guess here fails as an undefined-id TypeError rather than as anything
  // to do with letters.
  const steps = submitted.approvalSteps ?? [];
  const pending = steps.find((s: any) => s.status === 'PENDING') ?? steps[0];
  await apiPost(approverApi, `/letters/${letter.id}/steps/${pending.id}/decision`, {
    decision: 'APPROVE',
    comment: 'e2e approval',
  });

  return (await apiGet(api, `/letters/${letter.id}`)).data;
}

test.beforeAll(async () => {
  api = await apiLogin();
  approverApi = await apiLogin(APPROVER_EMAIL);
});

async function openLetter(page: Page, letterId: string) {
  await page.goto(`/dashboard/letters/${letterId}`);
  await expectPageHealthy(page);
}

test.describe('letters: submitting for approval', () => {
  test('the submit dialog asks for approvers only — never for a signatory', async ({ page }) => {
    const { orgUnit, department } = await hqFinance();
    const draft = (
      await apiPost(api, '/letters', {
        orgUnitId: orgUnit.id,
        departmentId: department.id,
        subject: `E2E draft ${Date.now()}`,
        bodyHtml: '<p>E2E body</p>',
        letterType: 'OUT',
      })
    ).data;

    await openLetter(page, draft.id);
    await page.getByRole('button', { name: /^Submit$/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Submit for approval/i })).toBeVisible();

    // The fusion that caused the bug: this dialog used to also ask who signs.
    // If that question comes back here, the signatory becomes an approver again.
    await expect(
      dialog.getByText(/who signs this letter|signatory/i),
      'the submit dialog is asking about signing again — the two actions have re-fused',
    ).toHaveCount(0);
  });
});

test.describe('letters: initiating signing', () => {
  test('an approved letter has no reference number, no document, and offers no dispatch', async ({ page }) => {
    const letter = await approvedLetter(`E2E approved ${Date.now()}`);

    // The state the split creates: approval is finished, but there is no letter
    // of record yet. Asserted against the API because these are absences, and an
    // absence in the DOM is easy to assert accidentally.
    expect(letter.status, 'the letter did not reach APPROVED').toBe('APPROVED');
    expect(letter.referenceNumber, 'a reference number was allocated before signing').toBeFalsy();
    expect(letter.documentId, 'a final document was filed before signing').toBeFalsy();

    await openLetter(page, letter.id);

    await expect(page.getByRole('button', { name: /Initiate signing/i })).toBeVisible();
    // Dispatching now would send a letter that has no reference number.
    await expect(
      page.getByRole('button', { name: /^Dispatch$/ }),
      'dispatch is offered on a letter that has not been signed and has no reference number',
    ).toHaveCount(0);
  });

  test('the signing dialog offers both scopes: a named person and a department-scoped role', async ({ page }) => {
    const letter = await approvedLetter(`E2E signing scopes ${Date.now()}`);
    await openLetter(page, letter.id);

    await page.getByRole('button', { name: /Initiate signing/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // This is the product rule, stated by the user: role = department-scoped,
    // named user = organisation-wide. Both must be offered, on this action.
    await expect(dialog.getByText(/A specific person signs/i)).toBeVisible();
    await expect(dialog.getByText(/any active member of this tenant/i)).toBeVisible();
    await expect(dialog.getByText(/Anyone holding a role signs/i)).toBeVisible();
    await expect(dialog.getByText(/department-scoped/i)).toBeVisible();

    // And it must say plainly that this is a signature request, not an approval —
    // the confusion that started this work.
    await expect(dialog.getByText(/signature request,\s*not an approval task/i)).toBeVisible();
  });

  test('initiating signing sends a SIGNATURE request, not another approval step', async ({ page }) => {
    const letter = await approvedLetter(`E2E initiate ${Date.now()}`);
    await openLetter(page, letter.id);

    const stepsBefore = ((await apiGet(api, `/letters/${letter.id}`)).data.approvalSteps ?? []).length;

    await page.getByRole('button', { name: /Initiate signing/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Name a specific signatory — the tenant-global scope.
    const personRadio = dialog.getByRole('radio').first();
    await personRadio.check();
    const picker = dialog.locator('select').first();
    const options = await picker.locator('option').all();
    const signatoryId = await options[1]!.getAttribute('value');
    expect(signatoryId, 'no signatory candidates were offered').toBeTruthy();
    await picker.selectOption(signatoryId!);

    const initiated = page.waitForResponse(
      (r) => r.url().includes('/initiate-signing') && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await dialog.getByRole('button', { name: /Initiate signing|Send|Confirm/i }).last().click();
    const response = await initiated;
    expect(response.status(), await response.text()).toBeLessThan(400);

    const after = (await apiGet(api, `/letters/${letter.id}`)).data;

    // The whole point: the signatory gets a signature task. If this had added an
    // approval step instead, that is the original bug exactly.
    expect(after.status, 'the letter did not enter PENDING_SIGNATURE').toBe('PENDING_SIGNATURE');
    expect(
      (after.approvalSteps ?? []).length,
      'initiating signing created an APPROVAL step — the signatory is being asked to approve again',
    ).toBe(stepsBefore);
  });

  test('signing cannot be initiated twice', async ({ page }) => {
    const letter = await approvedLetter(`E2E double initiate ${Date.now()}`);

    // The reference number is allocated at signature, gap-free — two ceremonies
    // would mean two numbers for one letter.
    const first = await apiPost(api, `/letters/${letter.id}/initiate-signing`, {
      signatory: { assignedUserId: api.user.id },
    }).then(() => 'accepted').catch((e: Error) => e.message);
    expect(first, `initiating signing failed outright: ${first}`).not.toContain('->');

    await openLetter(page, letter.id);
    await expect(
      page.getByRole('button', { name: /Initiate signing/i }),
      'the action is still offered on a letter whose ceremony has already started',
    ).toHaveCount(0);
  });
});

test.describe('letters: the register', () => {
  test('the correspondence list renders and shows a letter that was just created', async ({ page }) => {
    const subject = `E2E listed ${Date.now()}`;
    await approvedLetter(subject);

    await page.goto('/dashboard/letters');
    await expectPageHealthy(page);
    await expect(page.getByRole('heading', { level: 1, name: /^Correspondence$/ })).toBeVisible();
    await expect(page.getByText(subject).first()).toBeVisible();
  });
});
