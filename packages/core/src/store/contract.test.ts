import { FakeStore } from '../testing/fakes.js';
import { runStoreContract } from './contract.js';

runStoreContract(() => new FakeStore({ pageSize: 1 }), 'FakeStore');
