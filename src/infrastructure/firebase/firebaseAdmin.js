const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function resolveServiceAccount() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const configuredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!configuredPath) {
    return null;
  }

  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Service account file not found at ${absolutePath}`);
  }

  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function initializeFirebaseAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = resolveServiceAccount();
    const appOptions = serviceAccount
      ? {
          credential: admin.credential.cert(serviceAccount),
          projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
        }
      : {
          projectId: process.env.FIREBASE_PROJECT_ID
        };

    admin.initializeApp(appOptions);
    return {
      admin,
      appOptions,
      db: admin.firestore(),
      messaging: admin.messaging()
    };
  }

  return {
    admin,
    appOptions: { projectId: process.env.FIREBASE_PROJECT_ID || '' },
    db: admin.firestore(),
    messaging: admin.messaging()
  };
}

module.exports = {
  initializeFirebaseAdmin
};
