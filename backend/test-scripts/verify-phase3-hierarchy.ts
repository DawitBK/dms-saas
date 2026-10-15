/**
 * Phase 3 Verification Script: Hierarchical Organization
 * 
 * Tests that department/folder hierarchy works correctly:
 * - Department nesting with ltree paths
 * - Folder hierarchy within departments
 * - Cycle detection
 * - ACL inheritance from ancestors
 * - Department/folder validation
 */

import axios from 'axios';
import { loginAsAdmin as loginAsVerifyAdmin } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';

interface TestResult {
  passed: boolean;
  message: string;
  details?: any;
}

let adminToken: string;
let testTenantId: string;
let orgUnitId: string;
let rootDeptId: string;
let childDeptId: string;
let grandchildDeptId: string;
let rootFolderId: string;
let subFolderId: string;

/**
 * Helper: fetch the tenant's default org unit — departments require
 * orgUnitId, and every tenant is guaranteed at least one (auto-provisioned
 * on tenant creation / migration).
 */
async function fetchDefaultOrgUnitId(token: string): Promise<string> {
  const resp = await axios.get(`${API_BASE}/org-units`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const units = resp.data.data || resp.data;
  if (!units?.length) throw new Error('No org units found for tenant — run migrations/seed first');
  return units[0].id;
}

/**
 * Helper: Login as the verification administrator (qa.sysadmin@qa.local in qa-lab unless VERIFY_ADMIN_EMAIL /
 * VERIFY_TENANT say otherwise; see lib/dev-admin.ts, which also refuses a non-local target).
 */
async function loginAsAdmin(): Promise<string> {
  const session = await loginAsVerifyAdmin('verify-phase3-hierarchy.ts');
  testTenantId = session.tenantId;
  return session.token;
}

/**
 * Test 3.1: Create root department
 */
async function test_3_1_CreateRootDepartment(): Promise<TestResult> {
  try {
    const response = await axios.post(
      `${API_BASE}/departments`,
      {
        orgUnitId,
        code: `RT${Date.now().toString().slice(-6)}`,
        name: `Test Root Dept ${Date.now()}`,
        description: 'Root department for Phase 3 tests',
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const dept = response.data.department || response.data;
    rootDeptId = dept.id;

    if (dept.path === undefined || dept.path === null) {
      return {
        passed: false,
        message: 'Department path not computed',
        details: dept,
      };
    }

    // Root department (no parent) should have level 0
    if (dept.level !== 0) {
      return {
        passed: false,
        message: `Root department should have level 0, got ${dept.level}`,
        details: dept,
      };
    }

    return {
      passed: true,
      message: `Root department created: ${dept.name} (level=${dept.level}, path=${dept.path})`,
      details: { id: dept.id, path: dept.path, level: dept.level },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to create root department: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.2: Create child department
 */
async function test_3_2_CreateChildDepartment(): Promise<TestResult> {
  try {
    const response = await axios.post(
      `${API_BASE}/departments`,
      {
        orgUnitId,
        code: `CH${Date.now().toString().slice(-6)}`,
        name: `Test Child Dept ${Date.now()}`,
        description: 'Child department',
        parentId: rootDeptId,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const dept = response.data.department || response.data;
    childDeptId = dept.id;

    if (!dept.path) {
      return {
        passed: false,
        message: 'Child department path not computed',
        details: dept,
      };
    }

    // Child (one level under root) should have level 1
    if (dept.level !== 1) {
      return {
        passed: false,
        message: `Child department should have level 1, got ${dept.level}`,
        details: dept,
      };
    }

    // Path should include parent
    const pathParts = dept.path.split('.');
    if (pathParts.length !== 2) {
      return {
        passed: false,
        message: `Child path should have 2 parts, got ${pathParts.length}`,
        details: { path: dept.path },
      };
    }

    return {
      passed: true,
      message: `Child department created: ${dept.name} (level=${dept.level})`,
      details: { id: dept.id, path: dept.path, level: dept.level },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to create child department: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.3: Create grandchild department
 */
async function test_3_3_CreateGrandchildDepartment(): Promise<TestResult> {
  try {
    const response = await axios.post(
      `${API_BASE}/departments`,
      {
        orgUnitId,
        code: `GC${Date.now().toString().slice(-6)}`,
        name: `Test Grandchild Dept ${Date.now()}`,
        description: 'Grandchild department',
        parentId: childDeptId,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const dept = response.data.department || response.data;
    grandchildDeptId = dept.id;

    // Grandchild (two levels under root) should have level 2
    if (dept.level !== 2) {
      return {
        passed: false,
        message: `Grandchild should have level 2, got ${dept.level}`,
        details: dept,
      };
    }

    // Path should have 3 parts
    const pathParts = dept.path.split('.');
    if (pathParts.length !== 3) {
      return {
        passed: false,
        message: `Grandchild path should have 3 parts, got ${pathParts.length}`,
        details: { path: dept.path },
      };
    }

    return {
      passed: true,
      message: `Grandchild department created: ${dept.name} (level=${dept.level})`,
      details: { id: dept.id, path: dept.path, level: dept.level },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to create grandchild department: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.4: Get department tree
 */
async function test_3_4_GetDepartmentTree(): Promise<TestResult> {
  try {
    const response = await axios.get(`${API_BASE}/departments/tree`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const tree = response.data.data || response.data.tree || response.data;

    // Find our test root department
    const findDept = (nodes: any[], id: string): any => {
      if (!Array.isArray(nodes)) return null;
      for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
          const found = findDept(node.children, id);
          if (found) return found;
        }
      }
      return null;
    };

    const rootNode = findDept(tree, rootDeptId);
    if (!rootNode) {
      return {
        passed: false,
        message: 'Root department not found in tree',
      };
    }

    if (!rootNode.children || rootNode.children.length === 0) {
      return {
        passed: false,
        message: 'Child department not in tree',
        details: rootNode,
      };
    }

    const childNode = rootNode.children.find((c: any) => c.id === childDeptId);
    if (!childNode) {
      return {
        passed: false,
        message: 'Child department not found in root children',
      };
    }

    const grandchildNode = childNode.children?.find((c: any) => c.id === grandchildDeptId);
    if (!grandchildNode) {
      return {
        passed: false,
        message: 'Grandchild department not found',
      };
    }

    return {
      passed: true,
      message: 'Department tree structure correct (root → child → grandchild)',
      details: { levels: 3 },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to get department tree: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.5: Cycle detection (try to move root under grandchild)
 */
async function test_3_5_CycleDetection(): Promise<TestResult> {
  try {
    await axios.patch(
      `${API_BASE}/departments/${rootDeptId}/move`,
      { parentId: grandchildDeptId },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    return {
      passed: false,
      message: 'Cycle detection failed - move should have been rejected',
    };
  } catch (error: any) {
    // Should fail with cycle detection error
    if (error.response?.status === 400) {
      return {
        passed: true,
        message: 'Cycle detection working - circular move rejected',
      };
    }

    return {
      passed: false,
      message: `Unexpected error: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.6: Create folder in root department
 */
async function test_3_6_CreateFolderInDepartment(): Promise<TestResult> {
  try {
    const response = await axios.post(
      `${API_BASE}/folders`,
      {
        name: `Test Root Folder ${Date.now()}`,
        departmentId: rootDeptId,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const folder = response.data.data || response.data.folder || response.data;
    rootFolderId = folder.id;

    if (folder.departmentId !== rootDeptId) {
      return {
        passed: false,
        message: 'Folder department mismatch',
        details: folder,
      };
    }

    return {
      passed: true,
      message: `Folder created in department: ${folder.name}`,
      details: { id: folder.id, departmentId: folder.departmentId },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to create folder: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.7: Create subfolder
 */
async function test_3_7_CreateSubfolder(): Promise<TestResult> {
  try {
    const response = await axios.post(
      `${API_BASE}/folders`,
      {
        name: `Test Subfolder ${Date.now()}`,
        departmentId: rootDeptId,
        parentId: rootFolderId,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const folder = response.data.data || response.data.folder || response.data;
    subFolderId = folder.id;

    if (folder.parentId !== rootFolderId) {
      return {
        passed: false,
        message: 'Subfolder parent mismatch',
        details: folder,
      };
    }

    return {
      passed: true,
      message: `Subfolder created: ${folder.name}`,
      details: { id: folder.id, parentId: folder.parentId },
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Failed to create subfolder: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Test 3.8: Folder contents endpoint
 */
async function test_3_8_FolderContents(): Promise<TestResult> {
  try {
    const response = await axios.get(`${API_BASE}/folders/${rootFolderId}/contents`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const contents = response.data.data || response.data;

    if (!contents.folder) {
      return {
        passed: false,
        message: 'Folder metadata not returned',
      };
    }

    if (!Array.isArray(contents.subfolders)) {
      return {
        passed: false,
        message: 'Subfolders array not returned',
      };
    }

    const hasSubfolder = contents.subfolders.some((f: any) => f.id === subFolderId);
    if (!hasSubfolder) {
      return {
        passed: false,
        message: 'Subfolder not in contents',
        details: contents,
      };
    }

    return {
      passed: true,
      message: `Folder contents correct: ${contents.subfolders.length} subfolders, ${contents.documents?.length || 0} documents`,
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Folder contents failed: ${error.message}`,
      details: error.response?.data,
    };
  }
}

/**
 * Main test runner
 */
async function runPhase3Tests() {
  console.log('🧪 PHASE 3 VERIFICATION: Hierarchical Organization\n');

  console.log('📋 Setup: Logging in as admin...');
  adminToken = await loginAsAdmin();
  console.log('✅ Admin login successful\n');

  console.log('📋 Setup: Fetching default org unit...');
  orgUnitId = await fetchDefaultOrgUnitId(adminToken);
  console.log(`✅ Using org unit ${orgUnitId}\n`);

  const results: TestResult[] = [];

  console.log('🏢 Test 3.1: Create root department...');
  results.push(await test_3_1_CreateRootDepartment());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('👶 Test 3.2: Create child department...');
  results.push(await test_3_2_CreateChildDepartment());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('👼 Test 3.3: Create grandchild department...');
  results.push(await test_3_3_CreateGrandchildDepartment());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('🌳 Test 3.4: Get department tree...');
  results.push(await test_3_4_GetDepartmentTree());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('🔄 Test 3.5: Cycle detection...');
  results.push(await test_3_5_CycleDetection());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('📁 Test 3.6: Create folder in department...');
  results.push(await test_3_6_CreateFolderInDepartment());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('📂 Test 3.7: Create subfolder...');
  results.push(await test_3_7_CreateSubfolder());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  console.log('📋 Test 3.8: Folder contents endpoint...');
  results.push(await test_3_8_FolderContents());
  console.log(`  ${results[results.length - 1].passed ? '✅' : '❌'} ${results[results.length - 1].message}\n`);

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log('🎉 PHASE 3 VERIFICATION: ✅ ALL TESTS PASSED\n');
    process.exit(0);
  } else {
    console.log('❌ PHASE 3 VERIFICATION: FAILED\n');
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
runPhase3Tests().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

export { runPhase3Tests };
