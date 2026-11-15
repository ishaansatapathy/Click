import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { HydraDbGraphStore } from './hydradb-graph.js';
import { FakeGraphStore } from '../testing/fakes.js';
import { runGraphStoreContract } from './graph-contract.js';

runGraphStoreContract('fake', () => new FakeGraphStore());

runGraphStoreContract('hydradb-live', () => new HydraDbGraphStore({
  tokenFile: process.env.HYDRADB_TOKEN_FILE ?? resolve('.click', 'hydradb-token'),
}), { live: true, settle: () => sleep(1_000) });
