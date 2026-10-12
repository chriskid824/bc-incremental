// Worker entry: workers do not get a working tsx resolver from execArgv on Node 22, so
// register tsx here before loading the TypeScript worker (see pool.ts).
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
