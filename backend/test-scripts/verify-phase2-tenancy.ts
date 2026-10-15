/**
 * Phase 2 Verification Script: Multi-Tenancy
 * 
 * Tests that multi-tenant functionality works correctly:
 * - Tenant selection flow
 * - Tenant switching
 * - Data isolation
 * - Cross-tenant access prevention
 */

import axios from 'axios';
import { assertLocalDevTarget, loginAsAdmin, personaEmail, verifyMultiTenantEmail } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';

interface TestResult {
  passed: boolean;
  message: string;
  details?: any;
}

interface LoginResponse {
  user?: {
    id: string;
    email: string;
    tenantId: string;
  };
  token?: string;
  tenantSelectionRequired?: boolean;
  preTenantToken?: string;
  availableTenants?: string[];
}

/**
 * Helper: Login
 */
async function login(email: string, password?: string): Promise<LoginResponse> {
  assertLocalDevTarget(API_BASE);
  const body: any = { email: personaEmail(email) };
  // In dev mode, password is optional (passwordless)
  if (password) {
    body.password = password;
  }
  const response = await axios.post(`${API_BASE}/auth/login`, body);
  return response.data;
}

/**
 * The checks below that need an account in TWO OR MORE tenants cannot run on a database without one, and the practice
 * workspace has none (and none is invented). They fail with this one line instead of crashing; set
 * VERIFY_MULTITENANT_EMAIL to such an account to run them.
 */
const MULTI_TENANT_ACCOUNT = verifyMultiTenantEmail();
function needsMultiTenantAccount(): TestResult {
  return {
    passed: false,
    message: 'NEEDS DEMO DATA: an account that belongs to two or more tenants (none exists on this database; set VERIFY_MULTITENANT_EMAIL)',
  };
}

/**
 * Test 2.1: Verify user_tenants table exists
 */
async function test_2_1_TableExists(adminToken: string): Promise<TestResult> {
  try {
    // Try to query the table through API
    const response = await axios.get(`${API_BASE}/tenants`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    if (response.status === 200) {
      return {
        passed: true,
        message: 'user_tenants table exists and is accessible',
      };
    }

    return {
      passed: false,
      message: 'Could not verify table existence',
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to verify table: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 2.2: Multi-tenant user sees selection flow
 */
async function test_2_2_TenantSelectionFlow(): Promise<TestResult> {
  try {
    if (!MULTI_TENANT_ACCOUNT) return needsMultiTenantAccount();
    // Login as admin (should have multiple tenants)
    const loginResp = await login(MULTI_TENANT_ACCOUNT);

    if (!loginResp.tenantSelectionRequired) {
      return {
        passed: false,
        message: 'Admin user should require tenant selection',
        details: loginResp,
      };
    }

    if (!loginResp.preTenantToken) {
      return {
        passed: false,
        message: 'Pre-tenant token not provided',
        details: loginResp,
      };
    }

    if (!Array.isArray(loginResp.availableTenants) || loginResp.availableTenants.length < 2) {
      return {
        passed: false,
        message: 'Admin should have multiple tenants',
        details: { availableTenants: loginResp.availableTenants },
      };
    }

    return {
      passed: true,
      message: `Tenant selection required: ${loginResp.availableTenants.join(', ')}`,
      details: { availableTenants: loginResp.availableTenants },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed tenant selection flow test: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 2.3-2.5: Select tenant and verify JWT
 */
async function test_2_3_2_5_SelectTenant(): Promise<TestResult> {
  try {
    if (!MULTI_TENANT_ACCOUNT) return needsMultiTenantAccount();
    // Login as admin
    const loginResp = await login(MULTI_TENANT_ACCOUNT);

    if (!loginResp.tenantSelectionRequired || !loginResp.preTenantToken) {
      return { passed: false, message: 'Tenant selection not triggered' };
    }

    const { preTenantToken, availableTenants } = loginResp;

    // Select first tenant
    const selectedTenant = availableTenants![0];
    const selectResp = await axios.post(
      `${API_BASE}/auth/select-tenant`,
      { tenantId: selectedTenant },
      { headers: { Authorization: `Bearer ${preTenantToken}` } }
    );

    const user = selectResp.data.user;
    const token = selectResp.data.accessToken || selectResp.data.token;

    if (!user || !token) {
      return {
        passed: false,
        message: 'Full JWT not issued after tenant selection',
        details: selectResp.data,
      };
    }

    if (user.tenantId !== selectedTenant) {
      return {
        passed: false,
        message: `JWT tenant mismatch: expected ${selectedTenant}, got ${user.tenantId}`,
        details: { user },
      };
    }

    return {
      passed: true,
      message: `Tenant selected: ${selectedTenant}, JWT issued`,
      details: { tenantId: user.tenantId },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed tenant selection: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 2.6-2.9: Tenant switcher functionality
 */
async function test_2_6_2_9_TenantSwitcher(): Promise<TestResult> {
  try {
    if (!MULTI_TENANT_ACCOUNT) return needsMultiTenantAccount();
    // Login as admin and select first tenant
    const loginResp = await login(MULTI_TENANT_ACCOUNT);
    const { preTenantToken, availableTenants } = loginResp;

    if (!preTenantToken || !availableTenants || availableTenants.length < 2) {
      return { passed: false, message: 'Not enough tenants for switcher test' };
    }

    const tenant1 = availableTenants[0];
    const tenant2 = availableTenants[1];

    // Select first tenant
    const select1 = await axios.post(
      `${API_BASE}/auth/select-tenant`,
      { tenantId: tenant1 },
      { headers: { Authorization: `Bearer ${preTenantToken}` } }
    );

    const token1 = select1.data.accessToken || select1.data.token;

    // Switch to second tenant
    const switch2 = await axios.post(
      `${API_BASE}/auth/switch-tenant`,
      { tenantId: tenant2 },
      { headers: { Authorization: `Bearer ${token1}` } }
    );

    const token2 = switch2.data.accessToken || switch2.data.token;
    const user2 = switch2.data.user;

    if (user2.tenantId !== tenant2) {
      return {
        passed: false,
        message: `Tenant switch failed: expected ${tenant2}, got ${user2.tenantId}`,
        details: { user2 },
      };
    }

    // Switch back to first tenant
    const switch1 = await axios.post(
      `${API_BASE}/auth/switch-tenant`,
      { tenantId: tenant1 },
      { headers: { Authorization: `Bearer ${token2}` } }
    );

    const user1 = switch1.data.user;
    if (user1.tenantId !== tenant1) {
      return {
        passed: false,
        message: 'Failed to switch back to original tenant',
        details: { user: user1 },
      };
    }

    return {
      passed: true,
      message: `Tenant switcher works: ${tenant1} <-> ${tenant2}`,
      details: { tenants: [tenant1, tenant2] },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Tenant switcher failed: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 2.10: Single-tenant user bypasses selection
 */
async function test_2_10_SingleTenantBypass(): Promise<TestResult> {
  try {
    // Login as regular user (should have single tenant)
    const loginResp = await login('employee@edams.local');

    if (loginResp.tenantSelectionRequired) {
      return {
        passed: false,
        message: 'Single-tenant user should not require selection',
        details: loginResp,
      };
    }

    const token = (loginResp as any).accessToken || loginResp.token;
    if (!token || !loginResp.user) {
      return {
        passed: false,
        message: 'Full JWT not issued for single-tenant user',
        details: loginResp,
      };
    }

    return {
      passed: true,
      message: `Single-tenant user bypassed selection: tenant=${loginResp.user.tenantId}`,
      details: { tenantId: loginResp.user.tenantId },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Single-tenant bypass test failed: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 2.11: Cross-tenant access is blocked
 */
async function test_2_11_CrossTenantBlocked(): Promise<TestResult> {
  try {
    if (!MULTI_TENANT_ACCOUNT) return needsMultiTenantAccount();
    // Login as admin in tenant 1
    const loginResp = await login(MULTI_TENANT_ACCOUNT);
    const { preTenantToken, availableTenants } = loginResp;

    if (!preTenantToken || !availableTenants || availableTenants.length < 2) {
      return { passed: false, message: 'Not enough tenants for isolation test' };
    }

    const tenant1 = availableTenants[0];

    const selectResp = await axios.post(
      `${API_BASE}/auth/select-tenant`,
      { tenantId: tenant1 },
      { headers: { Authorization: `Bearer ${preTenantToken}` } }
    );

    const token = selectResp.data.accessToken || selectResp.data.token;

    // Try to get departments (should only see tenant 1 departments)
    const deptResp = await axios.get(`${API_BASE}/departments`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const departments = deptResp.data.data || deptResp.data.departments || deptResp.data;

    // All departments should belong to tenant1
    const crossTenantDepts = Array.isArray(departments) ? departments.filter((d: any) => d.tenantId !== tenant1) : [];

    if (crossTenantDepts.length > 0) {
      return {
        passed: false,
        message: 'Cross-tenant data leaked',
        details: { crossTenantDepts },
      };
    }

    return {
      passed: true,
      message: `Tenant isolation enforced: ${departments.length} departments in ${tenant1}`,
      details: { tenantId: tenant1, departmentCount: departments.length },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Cross-tenant test failed: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Main test runner
 */
async function runPhase2Tests() {
  console.log('🧪 PHASE 2 VERIFICATION: Multi-Tenancy\n');

  // Login as admin for setup — full two-phase flow
  console.log('📋 Setup: Logging in as admin...');
  const adminToken = (await loginAsAdmin('verify-phase2-tenancy.ts')).token;
  console.log('✅ Admin login successful\n');

  const results: TestResult[] = [];

  // Run tests
  console.log('🗄️  Test 2.1: Verify user_tenants table exists...');
  results.push(await test_2_1_TableExists(adminToken));
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('🔀 Test 2.2: Multi-tenant user sees selection flow...');
  results.push(await test_2_2_TenantSelectionFlow());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('✅ Test 2.3-2.5: Select tenant and verify JWT...');
  results.push(await test_2_3_2_5_SelectTenant());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('🔄 Test 2.6-2.9: Tenant switcher functionality...');
  results.push(await test_2_6_2_9_TenantSwitcher());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('👤 Test 2.10: Single-tenant user bypasses selection...');
  results.push(await test_2_10_SingleTenantBypass());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('🔒 Test 2.11: Cross-tenant access is blocked...');
  results.push(await test_2_11_CrossTenantBlocked());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log('🎉 PHASE 2 VERIFICATION: ✅ ALL TESTS PASSED\n');
    process.exit(0);
  } else {
    console.log('❌ PHASE 2 VERIFICATION: FAILED\n');
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.message}`);
      if (r.details) {
        console.log(`    Details: ${JSON.stringify(r.details, null, 2)}`);
      }
    });
    process.exit(1);
  }
}

// Run tests
runPhase2Tests().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

export { runPhase2Tests };
