#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

function parseArgs(argv) {
  const parsed = {
    email: "",
    uid: "",
    role: "admin",
    remove: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--email") {
      parsed.email = (argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--uid") {
      parsed.uid = (argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--role") {
      parsed.role = (argv[index + 1] || "").trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg === "--remove") {
      parsed.remove = true;
    }
  }

  return parsed;
}

function resolveServiceAccount() {
  const fromEnvJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (fromEnvJson) {
    return JSON.parse(fromEnvJson);
  }

  const fromGoogleCreds = (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (fromGoogleCreds) {
    const absolutePath = path.isAbsolute(fromGoogleCreds)
      ? fromGoogleCreds
      : path.resolve(process.cwd(), fromGoogleCreds);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Service account file not found: ${absolutePath}`);
    }
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  }

  const localDefault = path.resolve(__dirname, "..", "service-account.json");
  if (fs.existsSync(localDefault)) {
    return JSON.parse(fs.readFileSync(localDefault, "utf8"));
  }

  throw new Error(
    "Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON, " +
      "GOOGLE_APPLICATION_CREDENTIALS, or backend/service-account.json."
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email && !args.uid) {
    throw new Error("Missing target user. Use --email <email> or --uid <uid>.");
  }

  if (!["admin", "moderator"].includes(args.role)) {
    throw new Error('Invalid role. Use --role "admin" or --role "moderator".');
  }

  const serviceAccount = resolveServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
  });

  const auth = admin.auth();
  const user = args.email
    ? await auth.getUserByEmail(args.email)
    : await auth.getUser(args.uid);

  const existingClaims = user.customClaims || {};
  const nextClaims = { ...existingClaims };
  if (args.remove) {
    delete nextClaims[args.role];
  } else {
    nextClaims[args.role] = true;
  }

  await auth.setCustomUserClaims(user.uid, nextClaims);

  console.log(
    JSON.stringify(
      {
        ok: true,
        uid: user.uid,
        email: user.email || "",
        role: args.role,
        removed: args.remove,
        claims: nextClaims,
        note: "User must sign out and sign in again to receive updated token claims."
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
