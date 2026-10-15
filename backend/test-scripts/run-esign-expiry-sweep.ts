/** Runs one e-signing expiry sweep now (what the hourly worker does). Dev only; used by e2e/lifecycle.spec.ts. */
import '../src/config/env.js';
import { initModels, sequelize } from '../src/infrastructure/database/index.js';
import { expireSignatureRequests } from '../src/modules/esigning/esigning.service.js';
import '../src/modules/letters/letterSigningRecovery.js';

if (process.env.NODE_ENV !== 'development') { console.error('dev only'); process.exit(2); }
initModels();
await sequelize.authenticate();
const n = await expireSignatureRequests();
console.log(`EXPIRED ${n}`);
await sequelize.close();
process.exit(0);
