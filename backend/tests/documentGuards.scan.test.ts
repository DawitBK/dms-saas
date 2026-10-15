import { assertScanCleared } from '../src/shared/documentGuards.js';

const doc = (status: string) => ({
  id: 'd1', ownerId: 'u1', departmentId: 'dep1', status, isOnLegalHold: false, securityClassification: 'INTERNAL',
});

describe('assertScanCleared', () => {
  it('blocks a document whose async scan has not finished', () => {
    expect(() => assertScanCleared(doc('SCAN_PENDING'))).toThrow(expect.objectContaining({ code: 'ERR-DOCUMENT-SCAN-PENDING' }));
  });

  it('blocks a quarantined (virus-positive) document from download and preview', () => {
    expect(() => assertScanCleared(doc('QUARANTINED'))).toThrow(expect.objectContaining({ code: 'ERR-DOCUMENT-QUARANTINED', statusCode: 409 }));
  });

  it.each(['DRAFT', 'ACTIVE', 'ARCHIVED', 'IN_REVIEW'])('lets a %s document through', (status) => {
    expect(() => assertScanCleared(doc(status))).not.toThrow();
  });
});
