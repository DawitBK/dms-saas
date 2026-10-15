export {};

// TEST-3: report definitions drive a privileged Operations UI. Exercise the
// real registry, tenant-bound query handoff, aggregation, unknown-key guard,
// and shared CSV serialization without requiring a live database.
const mockQuery = jest.fn();

jest.mock('../src/infrastructure/database/sequelize.js', () => ({
  sequelize: { query: mockQuery },
}));

let listReports: typeof import('../src/modules/reports/reports.service.js').listReports;
let getReportDef: typeof import('../src/modules/reports/reports.service.js').getReportDef;
let runReport: typeof import('../src/modules/reports/reports.service.js').runReport;
let reportToCsv: typeof import('../src/modules/reports/reports.service.js').reportToCsv;

beforeAll(async () => {
  ({ listReports, getReportDef, runReport, reportToCsv } = await import('../src/modules/reports/reports.service.js'));
});

beforeEach(() => jest.clearAllMocks());

describe('reports.service', () => {
  it('exposes stable, unique metadata for every report without leaking generators', () => {
    const reports = listReports();
    expect(reports).toHaveLength(9);
    expect(new Set(reports.map((report) => report.key)).size).toBe(reports.length);
    expect(reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'workflow-sla', hasDateRange: false }),
      expect.objectContaining({ key: 'audit-activity', hasDateRange: true }),
    ]));
    expect(reports[0]).not.toHaveProperty('generate');
  });

  it('rejects an unknown report before any database query', () => {
    expect(() => getReportDef('not-a-report')).toThrow(expect.objectContaining({ code: 'ERR-REPORT-NOT-FOUND' }));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('runs workflow SLA only with the requested tenant and derives both totals', async () => {
    mockQuery.mockResolvedValue([
      { status: 'PENDING', count: 3, sla_breaches: 1 },
      { status: 'COMPLETED', count: 2, sla_breaches: 0 },
    ]);

    const result = await runReport('workflow-sla', 'tenant-a', {});

    expect(result).toMatchObject({
      key: 'workflow-sla',
      summary: { totalTasks: 5, totalBreaches: 1 },
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = :tenantId'),
      expect.objectContaining({ replacements: { tenantId: 'tenant-a' } }),
    );
  });

  it('passes the date range only to reports that declare and use it', async () => {
    mockQuery.mockResolvedValue([{ event_type: 'DOCUMENT_CREATED', count: 2, failures: 1 }]);

    const result = await runReport('audit-activity', 'tenant-a', {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    });

    expect(result.summary).toEqual({ totalEvents: 2, totalFailures: 1 });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('timestamp >= CAST(:from AS timestamptz)'),
      expect.objectContaining({
        replacements: expect.objectContaining({ tenantId: 'tenant-a', from: '2026-01-01T00:00:00.000Z' }),
      }),
    );
  });

  it('serializes report values through the shared safe CSV implementation', () => {
    expect(reportToCsv({
      key: 'example', name: 'Example', summary: {},
      columns: [{ key: 'name', label: 'Name' }],
      rows: [{ name: 'value, with comma' }],
    })).toBe('Name\r\n"value, with comma"');
  });
});
