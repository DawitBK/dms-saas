import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [resultPath, outputPath, product] = process.argv.slice(2);
if (!resultPath || !outputPath || !product) throw new Error('Usage: generate-test-status <jest-json> <markdown> <product>');

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const markdown = `# Automated Test Status\n\n> Generated from Jest JSON by \`npm run test:status\`. CI verifies that this file matches the test run.\n\n| Metric | Result |\n|---|---|\n| Product | ${product} |\n| Test suites | ${result.numPassedTestSuites} passed / ${result.numTotalTestSuites} total |\n| Tests | ${result.numPassedTests} passed / ${result.numTotalTests} total |\n| Failed | ${result.numFailedTests} |\n| Status | ${result.success ? 'PASS' : 'FAIL'} |\n`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, markdown);
