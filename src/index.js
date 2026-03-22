require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

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
}

const app = express();
const db = admin.firestore();
const messaging = admin.messaging();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/notifications/chat", async (req, res) => {
  try {
    console.log("Incoming /notifications/chat", req.body);
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      return res.status(401).json({ error: "Missing Firebase ID token" });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const senderId = decodedToken.uid;
    const { conversationId, text } = req.body || {};

    if (!conversationId || !text) {
      return res.status(400).json({ error: "conversationId and text are required" });
    }

    const conversationSnap = await db.collection("conversations").doc(conversationId).get();
    if (!conversationSnap.exists) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const conversation = conversationSnap.data() || {};
    const participantIds = Array.isArray(conversation.participantIds) ? conversation.participantIds : [];
    if (!participantIds.includes(senderId)) {
      return res.status(403).json({ error: "Sender is not a participant of this conversation" });
    }

    const receiverIds = participantIds.filter((id) => id && id !== senderId);
    if (receiverIds.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }

    const senderSnap = await db.collection("users").doc(senderId).get();
    const senderData = senderSnap.data() || {};
    const senderName = senderData.name || senderData.displayName || "Tin nhan moi";
    console.log("Sender resolved", { senderId, senderName, receiverIds, conversationId });

    let sentCount = 0;

    for (const receiverId of receiverIds) {
        const receiverSnap = await db.collection("users").doc(receiverId).get();
        if (!receiverSnap.exists) continue;

        const receiverData = receiverSnap.data() || {};
        const rawTokens = Array.isArray(receiverData.fcmTokens) ? receiverData.fcmTokens : [];
        const primaryToken = typeof receiverData.fcmToken === "string" ? receiverData.fcmToken : "";
        const tokens = Array.from(new Set([...rawTokens, primaryToken].filter(Boolean)));
        console.log("Receiver tokens", {
          receiverId,
          tokenCount: tokens.length,
          tokenPrefixes: tokens.map((token) => token.slice(0, 12))
        });
        if (tokens.length === 0) continue;

        const response = await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: senderName,
            body: text
          },
          data: {
            type: "chat_message",
            conversationId,
            senderId,
            title: senderName,
            body: text
          },
          android: {
            priority: "high"
          }
        });

        sentCount += response.successCount;
        console.log("FCM response", {
          receiverId,
          successCount: response.successCount,
          failureCount: response.failureCount
        });

        const invalidTokens = [];
        response.responses.forEach((result, index) => {
          if (result.success) return;
          const code = result.error?.code || "";
          console.log("FCM token failure", {
            receiverId,
            tokenPrefix: tokens[index]?.slice(0, 12),
            code
          });
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
          ) {
            invalidTokens.push(tokens[index]);
          }
        });

        if (invalidTokens.length > 0) {
          await db.collection("users").doc(receiverId).set(
            {
              fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
              ...(invalidTokens.includes(primaryToken)
                ? { fcmToken: admin.firestore.FieldValue.delete() }
                : {})
            },
            { merge: true }
          );
        }
    }

    return res.json({ ok: true, sent: sentCount });
  } catch (error) {
    console.error("Failed to send chat notification", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`UniMarket notification backend listening on port ${port}`);
});

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

  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}
