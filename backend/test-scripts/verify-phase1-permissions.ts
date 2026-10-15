/**
 * Phase 1 Verification Script: Multi-Role Permission Resolution
 * 
 * Tests that multi-role users get deterministic, consistent permissions
 * across multiple logins (union of all role permissions).
 */

import axios from 'axios';
import { assertLocalDevTarget, needsDemoData, verifyAdminEmail, verifyTenantId } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';
// A throwaway person with two roles, created in the verification tenant (qa-lab by default). DMS has no password login
// (production is SSO only, dev sign-in is passwordless), so no password is sent anywhere and none is stored.
const TEST_EMAIL = 'qa.verify-multirole@qa.local';

interface LoginResponse {
  user?: {
    id: string;
    email: string;
    role: string;
    roles: string[];
    permissions: string[];
    tenantId?: string;
  };
  token?: string;
  accessToken?: string;
  // Two-phase fields
  tenantSelectionRequired?: boolean;
  preTenantToken?: string;
  availableTenants?: string[];
  roleSelectionRequired?: boolean;
  preRoleToken?: string;
  availableRoles?: string[];
}

interface TestResult {
  passed: boolean;
  message: string;
  details?: any;
}

/**
 * Helper: Login (phase 1) — returns raw login response including pre-tenant fields.
 */
async function login(email: string): Promise<LoginResponse> {
  assertLocalDevTarget(API_BASE);
  const body: any = { email };
  const response = await axios.post(`${API_BASE}/auth/login`, body);
  return response.data;
}

/**
 * Helper: Full two-phase login — login then select-tenant (and select-role if required).
 * Always returns a full access token and user object.
 */
async function loginWithTenant(email: string, preferredRole?: string): Promise<{ token: string; user: NonNullable<LoginResponse['user']>; availableRoles?: string[] }> {
  const loginResp = await login(email);

  if (loginResp.tenantSelectionRequired && loginResp.preTenantToken && loginResp.availableTenants?.length) {
    const tenantId = verifyTenantId();
    if (!loginResp.availableTenants.includes(tenantId)) {
      needsDemoData('verify-phase1-permissions.ts', `"${email}" is not a member of tenant "${tenantId}" (set VERIFY_TENANT)`);
    }
    const selectResp = await axios.post(
      `${API_BASE}/auth/select-tenant`,
      { tenantId },
      { headers: { Authorization: `Bearer ${loginResp.preTenantToken}` } },
    );
    if (selectResp.data.roleSelectionRequired && selectResp.data.preRoleToken) {
      const availableRoles = selectResp.data.availableRoles || [];
      const role = preferredRole || availableRoles[0] || 'EMPLOYEE';
      const roleResp = await axios.post(
        `${API_BASE}/auth/select-role`,
        { roleName: role },
        { headers: { Authorization: `Bearer ${selectResp.data.preRoleToken}` } },
      );
      return { token: roleResp.data.accessToken || roleResp.data.token, user: roleResp.data.user, availableRoles };
    }
    return { token: selectResp.data.accessToken || selectResp.data.token, user: selectResp.data.user };
  }

  if (loginResp.roleSelectionRequired && loginResp.preRoleToken) {
    const availableRoles = loginResp.availableRoles || [];
    const role = preferredRole || availableRoles[0] || 'EMPLOYEE';
    const roleResp = await axios.post(
      `${API_BASE}/auth/select-role`,
      { roleName: role },
      { headers: { Authorization: `Bearer ${loginResp.preRoleToken}` } },
    );
    return { token: roleResp.data.accessToken || roleResp.data.token, user: roleResp.data.user, availableRoles };
  }

  const token = loginResp.accessToken || loginResp.token;
  if (!token || !loginResp.user) {
    throw new Error(`Login for ${email} returned neither a full token nor a pre-tenant token`);
  }
  return { token, user: loginResp.user };
}

/**
 * Test 1.1: Create test user with EMPLOYEE + SYSTEM_ADMIN roles
 */
async function test_1_1_CreateMultiRoleUser(adminToken: string): Promise<TestResult> {
  try {
    const rolesListResp = await axios.get(`${API_BASE}/roles`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const rolesList = rolesListResp.data.data || rolesListResp.data.roles || rolesListResp.data;
    const employeeRole = rolesList.find((r: any) => r.name === 'EMPLOYEE');
    const sysAdminRole = rolesList.find((r: any) => r.name === 'SYSTEM_ADMIN');

    if (!employeeRole || !sysAdminRole) {
      return { passed: false, message: 'Could not find required roles in /roles endpoint' };
    }

    // Check if user exists
    const usersResp = await axios.get(`${API_BASE}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    
    const userList = Array.isArray(usersResp.data) ? usersResp.data : (usersResp.data.data || usersResp.data.users || []);
    const existingUser = userList.find((u: any) => u.email === TEST_EMAIL);
    
    if (existingUser) {
      console.log('  ℹ User already exists, ensuring EMPLOYEE + SYSTEM_ADMIN roles are assigned');
      const userDetailResp = await axios.get(`${API_BASE}/users/${existingUser.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const userDetail = userDetailResp.data.data || userDetailResp.data.user || userDetailResp.data;
      const currentRoleIds = (userDetail.roles || []).map((r: any) => r.id);

      if (!currentRoleIds.includes(employeeRole.id)) {
        await axios.post(`${API_BASE}/users/${existingUser.id}/roles`, { roleId: employeeRole.id }, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
      if (!currentRoleIds.includes(sysAdminRole.id)) {
        await axios.post(`${API_BASE}/users/${existingUser.id}/roles`, { roleId: sysAdminRole.id }, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }

      return { passed: true, message: 'User exists and roles synchronized' };
    }

    // Create user
    const createResp = await axios.post(
      `${API_BASE}/users`,
      {
        email: TEST_EMAIL,
        firstName: 'Test',
        lastName: 'MultiRole',
        roleIds: [employeeRole.id, sysAdminRole.id],
        departmentIds: [],
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const userObj = createResp.data.data?.user || createResp.data.user || createResp.data;
    const userId = userObj.id;

    return {
      passed: true,
      message: `User created with EMPLOYEE + SYSTEM_ADMIN roles`,
      details: { userId },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to create user: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 1.2-1.3: Login 5 times (full two-phase) and verify permission set is identical
 */
async function test_1_2_1_3_DeterministicPermissions(): Promise<TestResult> {
  try {
    const permissionSets: string[][] = [];

    for (let i = 0; i < 5; i++) {
      const { user } = await loginWithTenant(TEST_EMAIL, 'SYSTEM_ADMIN');
      permissionSets.push([...(user.permissions ?? [])].sort());
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const firstSet = JSON.stringify(permissionSets[0]);
    const allIdentical = permissionSets.every(set => JSON.stringify(set) === firstSet);

    if (!allIdentical) {
      return {
        passed: false,
        message: 'Permission sets are NOT identical across logins',
        details: permissionSets,
      };
    }

    const hasSystemAdminPerms = permissionSets[0].includes('USER_CREATE') || permissionSets[0].includes('user:create') || permissionSets[0].includes('user:manage') || permissionSets[0].includes('USER_MANAGE');
    if (!hasSystemAdminPerms) {
      return {
        passed: false,
        message: 'Permission set does not include SYSTEM_ADMIN permissions',
        details: { permissions: permissionSets[0] },
      };
    }

    return {
      passed: true,
      message: `Permission set is deterministic (${permissionSets[0].length} permissions, all 5 logins identical)`,
      details: { permissionCount: permissionSets[0].length },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to test deterministic permissions: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 1.4: Verify JWT contains roles and permissions arrays after full two-phase login
 */
async function test_1_4_JWTStructure(): Promise<TestResult> {
  try {
    const { user, availableRoles } = await loginWithTenant(TEST_EMAIL, 'SYSTEM_ADMIN');

    if (!Array.isArray(user.roles)) {
      return { passed: false, message: 'JWT does not contain roles array', details: { user } };
    }
    if (!Array.isArray(user.permissions)) {
      return { passed: false, message: 'JWT does not contain permissions array', details: { user } };
    }
    if (typeof user.role !== 'string') {
      return { passed: false, message: 'JWT does not contain display role string', details: { user } };
    }

    const hasEmployee = availableRoles?.includes('EMPLOYEE') || user.roles.includes('EMPLOYEE') || user.roles.includes('SYSTEM_ADMIN');
    const hasSystemAdmin = availableRoles?.includes('SYSTEM_ADMIN') || user.roles.includes('SYSTEM_ADMIN');
    if (!hasEmployee || !hasSystemAdmin) {
      return {
        passed: false,
        message: 'Available roles / JWT roles do not include both EMPLOYEE and SYSTEM_ADMIN',
        details: { roles: user.roles, availableRoles },
      };
    }

    return {
      passed: true,
      message: `JWT structure correct: role=${user.role} roles=${user.roles.join(',')} permissions=${user.permissions.length}`,
      details: { role: user.role, roles: user.roles, permissionCount: user.permissions.length },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to verify JWT structure: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 1.5-1.6: Remove SYSTEM_ADMIN role and verify permissions drop
 */
async function test_1_5_1_6_PermissionDrop(adminToken: string): Promise<TestResult> {
  try {
    // Get user ID
    const usersResp = await axios.get(`${API_BASE}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const userList = Array.isArray(usersResp.data) ? usersResp.data : (usersResp.data.data || usersResp.data.users || []);
    const user = userList.find((u: any) => u.email === TEST_EMAIL);
    
    if (!user) {
      return { passed: false, message: 'Test user not found' };
    }

    // Get user roles
    const userDetailResp = await axios.get(`${API_BASE}/users/${user.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const userDetail = userDetailResp.data.data || userDetailResp.data.user || userDetailResp.data;
    const userRoles = userDetail.roles || [];

    const systemAdminRole = userRoles.find((r: any) => r.name === 'SYSTEM_ADMIN');
    if (!systemAdminRole) {
      return { passed: false, message: 'SYSTEM_ADMIN role not found on test user' };
    }

    // Remove SYSTEM_ADMIN role
    await axios.delete(`${API_BASE}/users/${user.id}/roles/${systemAdminRole.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 500));

    // Login again (full two-phase) and check permissions after role removal
    const { user: updatedUser } = await loginWithTenant(TEST_EMAIL);
    const newPermissions = updatedUser.permissions ?? [];

    const hasSystemAdminPerms = newPermissions.includes('USER_CREATE') || newPermissions.includes('user:create') || newPermissions.includes('user:manage') || newPermissions.includes('USER_MANAGE');
    if (hasSystemAdminPerms) {
      return {
        passed: false,
        message: 'User still has SYSTEM_ADMIN permissions after role removal',
        details: { permissions: newPermissions },
      };
    }

    if (updatedUser.roles.length !== 1 || updatedUser.roles[0] !== 'EMPLOYEE') {
      return {
        passed: false,
        message: 'User roles not updated correctly after removal',
        details: { roles: updatedUser.roles },
      };
    }

    return {
      passed: true,
      message: `Permissions correctly dropped to EMPLOYEE set (${newPermissions.length} permissions)`,
      details: { permissionCount: newPermissions.length },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to test permission drop: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Main test runner
 */
async function runPhase1Tests() {
  console.log('🧪 PHASE 1 VERIFICATION: Multi-Role Permission Resolution\n');

  console.log('📋 Setup: Logging in as admin...');
  const { token: adminToken } = await loginWithTenant(verifyAdminEmail());
  console.log('✅ Admin login successful\n');

  const results: TestResult[] = [];

  // Run tests
  console.log('🔧 Test 1.1: Create multi-role user...');
  results.push(await test_1_1_CreateMultiRoleUser(adminToken));
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('🔄 Test 1.2-1.3: Deterministic permissions (5 logins)...');
  results.push(await test_1_2_1_3_DeterministicPermissions());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('📦 Test 1.4: JWT structure validation...');
  results.push(await test_1_4_JWTStructure());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('➖ Test 1.5-1.6: Permission drop after role removal...');
  results.push(await test_1_5_1_6_PermissionDrop(adminToken));
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log('🎉 PHASE 1 VERIFICATION: ✅ ALL TESTS PASSED\n');
    process.exit(0);
  } else {
    console.log('❌ PHASE 1 VERIFICATION: FAILED\n');
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
runPhase1Tests().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

export { runPhase1Tests };
