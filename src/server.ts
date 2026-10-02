import { buildApp } from './app.js';

const app = buildApp();
await app.listen({ port: 6190, host: '127.0.0.1' });
