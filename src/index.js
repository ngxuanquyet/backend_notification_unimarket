const { getEnv } = require('./infrastructure/config/env');
const { initializeFirebaseAdmin } = require('./infrastructure/firebase/firebaseAdmin');
const { BackendService } = require('./application/services/BackendService');
const { BackendUseCases } = require('./application/usecases/BackendUseCases');
const { createBackendController } = require('./presentation/controllers/backendController');
const { createApp } = require('./app');

const env = getEnv();
console.log('[boot] UniMarket backend starting');
console.log('[boot] Environment', env);

const firebase = initializeFirebaseAdmin();
console.log('[boot] Firebase Admin initialized', {
  projectId: firebase.appOptions.projectId || ''
});

const service = new BackendService({
  admin: firebase.admin,
  db: firebase.db,
  messaging: firebase.messaging
});
const useCases = new BackendUseCases(service);
const controller = createBackendController(useCases);

const app = createApp(controller);

console.log('[boot] Starting HTTP server', { port: env.port });
app.listen(env.port, '0.0.0.0', () => {
  console.log(`UniMarket notification backend listening on port ${env.port}`);
});
