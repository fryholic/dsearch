import {createApplication as create} from '../../apps/daemon/dist/index.js';
// Baseline tests drive indexing explicitly; automatic synchronization has its own real-engine acceptance tests.
export const createApplication=(options={})=>create({...options,synchronization:{enabled:false,...options.synchronization}});
