/**
 * Master Verification Script
 * 
 * Runs all Phase 1-3 verification tests in sequence.
 * Use this for complete system validation.
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runPhase1Tests } from './verify-phase1-permissions.js';
import { runPhase2Tests } from './verify-phase2-tenancy.js';
import { runPhase3Tests } from './verify-phase3-hierarchy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runAllVerifications() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║           DMS v3 - COMPLETE VERIFICATION SUITE          ║');
  console.log('║                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const startTime = Date.now();
  let failedPhases = 0;

  // Phase 1
  console.log('═══════════════════════════════════════════════════════════\n');
  try {
    await runPhase1Tests();
  } catch (error) {
    console.error('Phase 1 verification failed\n');
    failedPhases++;
  }

  // Phase 2
  console.log('═══════════════════════════════════════════════════════════\n');
  try {
    await runPhase2Tests();
  } catch (error) {
    console.error('Phase 2 verification failed\n');
    failedPhases++;
  }

  // Phase 3
  console.log('═══════════════════════════════════════════════════════════\n');
  try {
    await runPhase3Tests();
  } catch (error) {
    console.error('Phase 3 verification failed\n');
    failedPhases++;
  }

  // Final summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║                    FINAL SUMMARY                          ║');
  console.log('║                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log(`Duration: ${duration}s`);
  console.log(`Phases tested: 3`);
  console.log(`Phases passed: ${3 - failedPhases}`);
  console.log(`Phases failed: ${failedPhases}\n`);

  if (failedPhases === 0) {
    console.log('🎉 ALL VERIFICATIONS PASSED! System is ready for Phase 4-9 testing.\n');
    process.exit(0);
  } else {
    console.log('❌ SOME VERIFICATIONS FAILED. Please review the logs above.\n');
    process.exit(1);
  }
}

// Run tests
runAllVerifications().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

export { runAllVerifications };
