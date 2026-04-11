require("dotenv").config();

console.log("[boot] UniMarket backend starting");
console.log("[boot] Environment", {
  nodeEnv: process.env.NODE_ENV || "",
  port: process.env.PORT || "",
  hasFirebaseProjectId: Boolean(process.env.FIREBASE_PROJECT_ID),
  hasFirebaseServiceAccountJson: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || ""
});

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

if (!admin.apps.length) {
  console.log("[boot] Initializing Firebase Admin");
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
  console.log("[boot] Firebase Admin initialized", {
    projectId: appOptions.projectId || ""
  });
}

const app = express();
const db = admin.firestore();
const messaging = admin.messaging();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function logInfo(scope, message, data = {}) {
  console.log(`[${scope}] ${message}`, data);
}

function logWarn(scope, message, data = {}) {
  console.warn(`[${scope}] ${message}`, data);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/webhooks/sepay", async (req, res) => {
  try {
    verifySePayWebhook(req);

    const transaction = normalizeSePayWebhook(req.body || {});
    logInfo("sepay-webhook", "Received webhook payload", {
      transactionId: transaction.id,
      transferType: transaction.transferType,
      transferContent: transaction.transferContent,
      amount: transaction.amount,
      status: transaction.status
    });
    if (!transaction.id) {
      throw httpError(400, "Missing SePay transaction id");
    }

    const transactionDocId = `sepay_${transaction.id}`;
    const transactionPayload = {
      provider: "SEPAY",
      providerTransactionId: transaction.id,
      gateway: transaction.gateway,
      transactionDate: transaction.transactionDate || "",
      transactionTimestamp: transaction.transactionTimestamp || 0,
      accountNumber: transaction.accountNumber,
      receiverAccount: transaction.accountNumber,
      code: transaction.code,
      transferContent: transaction.transferContent,
      reference: transaction.transferContent,
      content: transaction.content,
      addInfo: transaction.content,
      description: transaction.description,
      referenceCode: transaction.referenceCode,
      transferType: transaction.transferType,
      amount: transaction.amount,
      transferAmount: transaction.amount,
      accumulated: transaction.accumulated,
      subAccount: transaction.subAccount,
      status: transaction.status,
      providerStatus: transaction.providerStatus,
      raw: req.body || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection("paymentTransactions").doc(transactionDocId).set(
      transactionPayload,
      { merge: true }
    );

    let matchedOrderId = "";
    let matchedOrderStatus = "";

    if (transaction.transferType === "IN" && transaction.transferContent) {
      const matchedOrder = await findOrderByTransferContent(transaction.transferContent);
      logInfo("sepay-webhook", "Matching order by transfer content", {
        transferContent: transaction.transferContent,
        matchedOrderId: matchedOrder?.id || "",
        matchedOrderStatus: matchedOrder?.status || ""
      });
      if (matchedOrder) {
        const result = await confirmTransferPayment({
          orderId: matchedOrder.id,
          order: matchedOrder,
          paymentMatch: {
            id: transactionDocId,
            reference: transaction.transferContent
          }
        });

        await finalizeTransferPayment(result);
        matchedOrderId = result.orderId;
        matchedOrderStatus = result.status;
        logInfo("sepay-webhook", "Payment confirmation finished", {
          orderId: matchedOrderId,
          status: matchedOrderStatus,
          wasChanged: Boolean(result.wasChanged)
        });
      }
    } else {
      logInfo("sepay-webhook", "Skip matching because transfer is not inbound or missing content", {
        transferType: transaction.transferType,
        hasTransferContent: Boolean(transaction.transferContent)
      });
    }

    return res.status(200).json({
      success: true,
      transactionId: transactionDocId,
      orderId: matchedOrderId || undefined,
      status: matchedOrderStatus || undefined
    });
  } catch (error) {
    console.error("Failed to process SePay webhook", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      success: false,
      error: error?.message || "Internal server error"
    });
  }
});

app.post("/notifications/chat", async (req, res) => {
  try {
    console.log("Incoming /notifications/chat", req.body);
    const decodedToken = await requireAuth(req);
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
        sentCount += await sendNotificationToUser(receiverId, {
          title: senderName,
          body: text,
          data: {
            type: "chat_message",
            conversationId,
            senderId
          }
        });
    }

    return res.json({ ok: true, sent: sentCount });
  } catch (error) {
    console.error("Failed to send chat notification", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/checkout/buy-now", async (req, res) => {
  try {
    const decodedToken = await requireAuth(req);
    const buyerId = decodedToken.uid;
    const purchase = normalizePurchaseRequest(req.body || {});
    const isTransferPayment = isTransferPaymentMethod(purchase.paymentMethod);

    const result = await db.runTransaction(async (transaction) => {
      const productRef = db.collection("products").doc(purchase.productId);
      const orderRef = db.collection("orders").doc();
      const buyerRef = db.collection("users").doc(buyerId);

      const productSnap = await transaction.get(productRef);
      if (!productSnap.exists) {
        throw httpError(404, "This product is no longer available");
      }

      const product = productSnap.data() || {};
      const sellerId = typeof product.userId === "string" ? product.userId : "";
      const sellerName = typeof product.sellerName === "string" ? product.sellerName : "";
      const productName = typeof product.name === "string" ? product.name : "";
      const unitPrice = Number(product.price || 0);
      const availableQuantity = Math.max(0, Number(product.quantityAvailable || 0));
      const imageUrls = Array.isArray(product.imageUrls) ? product.imageUrls.filter((item) => typeof item === "string") : [];
      const deliveryMethodsAvailable = Array.isArray(product.deliveryMethodsAvailable)
        ? product.deliveryMethodsAvailable.filter((item) => typeof item === "string")
        : [];

      validatePurchaseRequest({
        purchase,
        buyerId,
        sellerId,
        availableQuantity,
        deliveryMethodsAvailable
      });

      const remainingQuantity = availableQuantity - purchase.quantity;
      const deliveryFee = purchase.deliveryMethod === "SHIPPING" ? SHIPPING_FEE : 0;
      const subtotal = unitPrice * purchase.quantity;
      const total = subtotal + PLATFORM_FEE + deliveryFee;
      const transferContent = isTransferPayment ? buildTransferContent(orderRef.id) : "";
      const paymentExpiresAt = isTransferPayment
        ? Date.now() + TRANSFER_PAYMENT_WINDOW_MS
        : null;
      const sellerRef = db.collection("users").doc(sellerId);
      const buyerOrderRef = buyerRef.collection("orders").doc(orderRef.id);
      const sellerOrderRef = sellerRef.collection("orders").doc(orderRef.id);
      const orderPayload = {
        orderId: orderRef.id,
        source: "buy_now",
        status: isTransferPayment ? "WAITING_PAYMENT" : "WAITING_CONFIRMATION",
        buyerId,
        buyerName: decodedToken.name || decodedToken.email || "Student Buyer",
        sellerId,
        sellerName,
        productId: purchase.productId,
        productName,
        productImageUrl: imageUrls[0] || "",
        productDetail: typeof product.condition === "string" ? product.condition : "",
        unitPrice,
        quantity: purchase.quantity,
        subtotal,
        platformFee: PLATFORM_FEE,
        deliveryFee,
        total,
        paymentMethod: purchase.paymentMethod,
        paymentMethodDetails: purchase.paymentMethodDetails || null,
        deliveryMethod: purchase.deliveryMethod,
        meetingPoint: purchase.meetingPoint || "",
        buyerAddress: purchase.buyerAddress || null,
        sellerAddress: purchase.sellerAddress || null,
        transferContent,
        paymentExpiresAt,
        paymentConfirmedAt: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      transaction.set(orderRef, orderPayload);
      transaction.set(buyerOrderRef, orderPayload);
      transaction.set(sellerOrderRef, orderPayload);
      transaction.set(
        productRef,
        {
          quantityAvailable: remainingQuantity,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      if (!isTransferPayment) {
        transaction.set(
          buyerRef,
          {
            boughtCount: admin.firestore.FieldValue.increment(1)
          },
          { merge: true }
        );
        transaction.set(
          sellerRef,
          {
            soldCount: admin.firestore.FieldValue.increment(1)
          },
          { merge: true }
        );
      }

      return {
        orderId: orderRef.id,
        remainingQuantity,
        sellerId,
        buyerName: decodedToken.name || decodedToken.email || "Student Buyer",
        productName,
        requiresTransferPayment: isTransferPayment
      };
    });

    if (!result.requiresTransferPayment) {
      await runBestEffort(async () => {
        await sendNotificationToUser(result.sellerId, {
          title: "New order received",
          body: `${result.buyerName} placed an order for ${result.productName || "your item"}.`,
          data: {
            type: "order_created",
            orderId: result.orderId
          }
        });
      }, "Failed to send new order notification");
    }

    return res.json(result);
  } catch (error) {
    console.error("Failed to confirm buy now purchase", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "Internal server error" });
  }
});

app.post("/orders/:orderId/status", async (req, res) => {
  try {
    const decodedToken = await requireAuth(req);
    const actorId = decodedToken.uid;
    const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
    const statusUpdate = normalizeOrderStatusUpdateRequest(req.body || {});
    logInfo("order-status", "Status update requested", {
      orderId,
      actorId,
      requestedStatus: req.body?.status,
      normalizedStatus: statusUpdate.status
    });

    if (!orderId) {
      throw httpError(400, "orderId is required");
    }
    if (!statusUpdate.status) {
      throw httpError(400, "status is required");
    }

    const result = await db.runTransaction(async (transaction) => {
      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw httpError(404, "Order not found");
      }

      const order = orderSnap.data() || {};
      const sellerId = typeof order.sellerId === "string" ? order.sellerId.trim() : "";
      const buyerId = typeof order.buyerId === "string" ? order.buyerId.trim() : "";
      const productId = typeof order.productId === "string" ? order.productId.trim() : "";
      const productName = typeof order.productName === "string" ? order.productName : "your order";
      const sellerName = typeof order.sellerName === "string" ? order.sellerName : "Campus Seller";
      const quantity = Number.isFinite(Number(order.quantity)) && Number(order.quantity) > 0
        ? Number(order.quantity)
        : 1;
      const currentStatus = normalizeOrderStatus(order.status);
      const nextStatus = statusUpdate.status;
      const deliveryMethod =
        typeof order.deliveryMethod === "string" ? order.deliveryMethod.trim() : "";
      const buyerOrderRef = buyerId
        ? db.collection("users").doc(buyerId).collection("orders").doc(orderId)
        : null;
      const sellerOrderRef = sellerId
        ? db.collection("users").doc(sellerId).collection("orders").doc(orderId)
        : null;
      const isBuyerConfirmingTransferPayment =
        buyerId === actorId && nextStatus === "WAITING_CONFIRMATION";
      const isBuyerCancellingPendingPayment =
        buyerId === actorId &&
        currentStatus === "WAITING_PAYMENT" &&
        nextStatus === "CANCELLED";
      logInfo("order-status", "Loaded order for status update", {
        orderId,
        actorId,
        buyerId,
        sellerId,
        currentStatus,
        nextStatus,
        isBuyerConfirmingTransferPayment,
        isBuyerCancellingPendingPayment
      });

      if (!sellerId) {
        throw httpError(400, "Order seller information is missing");
      }
      if (
        sellerId !== actorId &&
        !isBuyerConfirmingTransferPayment &&
        !isBuyerCancellingPendingPayment
      ) {
        throw httpError(403, "You can only update your own orders");
      }

      validateOrderStatusTransition({
        currentStatus,
        nextStatus,
        deliveryMethod
      });

      if (currentStatus === nextStatus) {
        logInfo("order-status", "No-op update because status unchanged", {
          orderId,
          status: currentStatus
        });
        return {
          orderId,
          status: currentStatus,
          buyerId,
          productName,
          sellerName,
          wasChanged: false
        };
      }

      const orderStatusPayload = {
        status: nextStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (isBuyerConfirmingTransferPayment) {
        orderStatusPayload.paymentConfirmedAt = admin.firestore.FieldValue.serverTimestamp();
        orderStatusPayload.paymentExpiresAt = 0;
      }

      transaction.set(orderRef, orderStatusPayload, { merge: true });
      if (buyerOrderRef) {
        transaction.set(buyerOrderRef, orderStatusPayload, { merge: true });
      }
      if (sellerOrderRef) {
        transaction.set(sellerOrderRef, orderStatusPayload, { merge: true });
      }

      if (shouldRestockInventory(currentStatus, nextStatus) && productId) {
        const productRef = db.collection("products").doc(productId);
        const productSnap = await transaction.get(productRef);
        if (productSnap.exists) {
          const product = productSnap.data() || {};
          const availableQuantity = Math.max(0, Number(product.quantityAvailable || 0));
          transaction.set(
            productRef,
            {
              quantityAvailable: availableQuantity + quantity,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );
        }
      }

      if (shouldRollbackCounters(currentStatus, nextStatus)) {
        if (buyerId) {
          transaction.set(
            db.collection("users").doc(buyerId),
            { boughtCount: admin.firestore.FieldValue.increment(-1) },
            { merge: true }
          );
        }
        if (sellerId) {
          transaction.set(
            db.collection("users").doc(sellerId),
            { soldCount: admin.firestore.FieldValue.increment(-1) },
            { merge: true }
          );
        }
      }

      return {
        orderId,
        status: nextStatus,
        buyerId,
        productName,
        sellerName,
        wasChanged: true
      };
    });

    if (result.wasChanged && result.buyerId) {
      await runBestEffort(async () => {
        const notification = buildBuyerOrderStatusNotification(result);
        await sendNotificationToUser(result.buyerId, notification);
      }, "Failed to send order status notification");
    }

    logInfo("order-status", "Status update completed", {
      orderId: result.orderId,
      status: result.status,
      wasChanged: Boolean(result.wasChanged)
    });

    return res.json({
      ok: true,
      orderId: result.orderId,
      status: result.status
    });
  } catch (error) {
    console.error("Failed to update order status", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "Internal server error" });
  }
});

app.post("/orders/:orderId/payment/check", async (req, res) => {
  try {
    const decodedToken = await requireAuth(req);
    const buyerId = decodedToken.uid;
    const orderId = typeof req.params.orderId === "string" ? req.params.orderId.trim() : "";
    logInfo("payment-check", "Payment check requested", { orderId, buyerId });

    if (!orderId) {
      throw httpError(400, "orderId is required");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      throw httpError(404, "Order not found");
    }

    const order = orderSnap.data() || {};
    const orderBuyerId = normalizeActorId(order.buyerId);
    if (!orderBuyerId) {
      throw httpError(400, "Order buyer information is missing");
    }
    if (orderBuyerId !== buyerId) {
      throw httpError(403, "You can only check payment for your own orders");
    }

    const normalizedStatus = normalizeOrderStatus(order.status);
    logInfo("payment-check", "Loaded order for payment check", {
      orderId,
      buyerId,
      orderBuyerId,
      currentStatus: normalizedStatus,
      paymentMethod: order.paymentMethod,
      paymentExpiresAt: toMillis(order.paymentExpiresAt)
    });
    if (!isTransferPaymentMethod(order.paymentMethod)) {
      logInfo("payment-check", "Skip transfer check because payment method is not transfer", {
        orderId,
        paymentMethod: order.paymentMethod
      });
      return res.json({
        ok: true,
        orderId,
        status: normalizedStatus || "WAITING_CONFIRMATION",
        statusLabel: toDisplayStatus(normalizedStatus || "WAITING_CONFIRMATION"),
        paymentConfirmedAt: toMillis(order.paymentConfirmedAt),
        paymentExpiresAt: toMillis(order.paymentExpiresAt)
      });
    }

    if (normalizedStatus === "WAITING_PAYMENT" && isPendingPaymentExpired(order)) {
      logWarn("payment-check", "Payment window expired; expiring order", { orderId });
      const cancelledOrder = await expirePendingTransferOrder({ orderId, order });
      return res.json({
        ok: true,
        orderId,
        status: cancelledOrder.status,
        statusLabel: toDisplayStatus(cancelledOrder.status),
        paymentConfirmedAt: 0,
        paymentExpiresAt: cancelledOrder.paymentExpiresAt
      });
    }

    if (normalizedStatus && normalizedStatus !== "WAITING_PAYMENT") {
      logInfo("payment-check", "Order already moved out of WAITING_PAYMENT", {
        orderId,
        status: normalizedStatus
      });
      return res.json({
        ok: true,
        orderId,
        status: normalizedStatus,
        statusLabel: toDisplayStatus(normalizedStatus),
        paymentConfirmedAt: toMillis(order.paymentConfirmedAt),
        paymentExpiresAt: toMillis(order.paymentExpiresAt)
      });
    }

    const paymentMatch = await findMatchingTransferPayment({ orderId, order });
    if (!paymentMatch) {
      logInfo("payment-check", "No matching transfer payment found", {
        orderId,
        expectedTransferContent: order.transferContent || buildTransferContent(orderId),
        expectedAmount: Number(order.total || order.totalAmount || 0)
      });
      return res.json({
        ok: true,
        orderId,
        status: "WAITING_PAYMENT",
        statusLabel: toDisplayStatus("WAITING_PAYMENT"),
        paymentConfirmedAt: 0,
        paymentExpiresAt: toMillis(order.paymentExpiresAt)
      });
    }

    logInfo("payment-check", "Found matching transfer payment", {
      orderId,
      paymentMatchId: paymentMatch.id || "",
      paymentMatchReference: paymentMatch.reference || "",
      paymentMatchAmount: paymentMatch.amount || 0
    });
    const result = await confirmTransferPayment({
      orderId,
      order,
      paymentMatch
    });

    await finalizeTransferPayment(result);
    logInfo("payment-check", "Payment check completed with confirmation", {
      orderId: result.orderId,
      status: result.status,
      wasChanged: Boolean(result.wasChanged)
    });

    return res.json({
      ok: true,
      orderId: result.orderId,
      status: result.status,
      statusLabel: toDisplayStatus(result.status),
      paymentConfirmedAt: result.paymentConfirmedAt,
      paymentExpiresAt: result.paymentExpiresAt
    });
  } catch (error) {
    console.error("Failed to check transfer payment", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "Internal server error" });
  }
});

app.get("/orders/buyer", async (req, res) => {
  try {
    const decodedToken = await requireAuth(req);
    await expireOverdueTransferOrdersForUser(decodedToken.uid);
    const orders = await fetchOrdersForActor({
      actorField: "buyerId",
      primaryField: "buyerId",
      fallbackField: "buyerUid",
      userId: decodedToken.uid,
      includeUserScopedCollection: true
    });

    return res.json({ orders });
  } catch (error) {
    console.error("Failed to load buyer orders", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "Internal server error" });
  }
});

app.get("/orders/seller", async (req, res) => {
  try {
    const decodedToken = await requireAuth(req);
    const orders = await fetchOrdersForActor({
      actorField: "sellerId",
      primaryField: "sellerId",
      fallbackField: "sellerUid",
      userId: decodedToken.uid,
      includeUserScopedCollection: true
    });

    return res.json({ orders });
  } catch (error) {
    console.error("Failed to load seller orders", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "Internal server error" });
  }
});

const port = Number(process.env.PORT || 8080);
console.log("[boot] Starting HTTP server", { port });
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

function verifySePayWebhook(req) {
  const configuredApiKey = typeof process.env.SEPAY_WEBHOOK_API_KEY === "string"
    ? process.env.SEPAY_WEBHOOK_API_KEY.trim()
    : "";
  const configuredSecretKey = typeof process.env.SEPAY_WEBHOOK_SECRET_KEY === "string"
    ? process.env.SEPAY_WEBHOOK_SECRET_KEY.trim()
    : "";

  if (!configuredApiKey && !configuredSecretKey) {
    return;
  }

  const authorizationHeader = typeof req.headers.authorization === "string"
    ? req.headers.authorization.trim()
    : "";
  const secretHeader = typeof req.headers["x-secret-key"] === "string"
    ? req.headers["x-secret-key"].trim()
    : "";
  const receivedApiKey = parseSePayApiKey(authorizationHeader);

  if (configuredApiKey && receivedApiKey && receivedApiKey === configuredApiKey) {
    return;
  }
  if (configuredSecretKey && secretHeader && secretHeader === configuredSecretKey) {
    return;
  }

  throw httpError(401, "Unauthorized SePay webhook");
}

function parseSePayApiKey(headerValue) {
  const match = /^Apikey\s+(.+)$/i.exec(headerValue || "");
  return match ? match[1].trim() : "";
}

async function requireAuth(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) {
    throw httpError(401, "Missing Firebase ID token");
  }

  return admin.auth().verifyIdToken(idToken);
}

async function fetchOrdersForActor({
  actorField,
  primaryField,
  fallbackField,
  userId,
  includeUserScopedCollection
}) {
  const mergedOrders = [];

  mergedOrders.push(
    ...(await fetchRootOrders(userId, primaryField, fallbackField, actorField))
  );

  if (includeUserScopedCollection) {
    mergedOrders.push(...(await fetchUserScopedOrders(userId, actorField)));
  }

  return mergedOrders
    .filter(Boolean)
    .filter((order) => normalizeActorId(order?.[actorField]) === userId)
    .reduce((accumulator, order) => {
      const key = order.id || order.documentPath;
      const existingIndex = accumulator.findIndex((item) => (item.id || item.documentPath) === key);
      if (existingIndex < 0) {
        accumulator.push(order);
        return accumulator;
      }

      const existing = accumulator[existingIndex];
      const existingTimestamp = Math.max(existing.updatedAt || 0, existing.createdAt || 0);
      const candidateTimestamp = Math.max(order.updatedAt || 0, order.createdAt || 0);
      if (candidateTimestamp >= existingTimestamp) {
        accumulator[existingIndex] = order;
      }
      return accumulator;
    }, [])
    .sort((left, right) => Math.max(right.updatedAt, right.createdAt) - Math.max(left.updatedAt, left.createdAt));
}

async function fetchRootOrders(userId, primaryField, fallbackField, actorField) {
  const documents = [];

  const primarySnapshot = await db.collection("orders").where(primaryField, "==", userId).get();
  primarySnapshot.forEach((document) => documents.push(document));

  const fallbackSnapshot = await db.collection("orders").where(fallbackField, "==", userId).get();
  fallbackSnapshot.forEach((document) => documents.push(document));

  return documents
    .filter((document, index, collection) =>
      collection.findIndex((candidate) => candidate.ref.path === document.ref.path) === index
    )
    .map(mapOrderDocument)
    .filter((order) => normalizeActorId(order?.[actorField]) === userId)
    .filter(Boolean);
}

async function fetchUserScopedOrders(userId, actorField) {
  const snapshot = await db.collection("users").doc(userId).collection("orders").get();
  return snapshot.docs
    .map(mapOrderDocument)
    .filter((order) => normalizeActorId(order?.[actorField]) === userId)
    .filter(Boolean);
}

function mapOrderDocument(document) {
  try {
    const order = document.data() || {};
    const rawStatus = typeof order.status === "string" ? order.status : "";
    const normalizedStatus = normalizeOrderStatus(rawStatus) || rawStatus || "UNKNOWN";

    return {
      id: document.id,
      documentPath: document.ref.path,
      buyerId: typeof order.buyerId === "string" ? order.buyerId : "",
      buyerName: typeof order.buyerName === "string" ? order.buyerName : "",
      sellerId: typeof order.sellerId === "string" ? order.sellerId : "",
      sellerName: typeof order.sellerName === "string" ? order.sellerName : "",
      productId: typeof order.productId === "string" ? order.productId : "",
      productName: typeof order.productName === "string" ? order.productName : "",
      productDetail: typeof order.productDetail === "string" ? order.productDetail : "",
      productImageUrl: typeof order.productImageUrl === "string" ? order.productImageUrl : "",
      quantity: Number.isFinite(Number(order.quantity)) ? Number(order.quantity) : 1,
      unitPrice: Number.isFinite(Number(order.unitPrice)) ? Number(order.unitPrice) : 0,
      totalAmount: Number.isFinite(Number(order.total)) ? Number(order.total) : 0,
      deliveryMethod: typeof order.deliveryMethod === "string" ? order.deliveryMethod : "",
      paymentMethod: typeof order.paymentMethod === "string" ? order.paymentMethod : "",
      paymentMethodDetails: normalizePaymentMethod(order.paymentMethodDetails),
      meetingPoint: typeof order.meetingPoint === "string" ? order.meetingPoint : "",
      buyerAddress: mapAddressPayload(order.buyerAddress),
      sellerAddress: mapAddressPayload(order.sellerAddress),
      transferContent: typeof order.transferContent === "string" ? order.transferContent : "",
      paymentExpiresAt: toMillis(order.paymentExpiresAt),
      paymentConfirmedAt: toMillis(order.paymentConfirmedAt),
      status: normalizedStatus,
      statusLabel: toDisplayStatus(normalizedStatus),
      createdAt: toMillis(order.createdAt),
      updatedAt: toMillis(order.updatedAt)
    };
  } catch (_error) {
    return null;
  }
}

function mapAddressPayload(value) {
  if (!value || typeof value !== "object") return null;

  return {
    id: typeof value.id === "string" ? value.id : "",
    recipientName: typeof value.recipientName === "string" ? value.recipientName : "",
    phoneNumber: typeof value.phoneNumber === "string" ? value.phoneNumber : "",
    addressLine: typeof value.addressLine === "string" ? value.addressLine : "",
    isDefault: Boolean(value.isDefault)
  };
}

function toMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function normalizeActorId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePurchaseRequest(body) {
  return {
    productId: typeof body.productId === "string" ? body.productId.trim() : "",
    quantity: Number(body.quantity || 0),
    deliveryMethod: typeof body.deliveryMethod === "string" ? body.deliveryMethod.trim() : "",
    paymentMethod: typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : "",
    paymentMethodDetails: normalizePaymentMethod(body.paymentMethodDetails),
    meetingPoint: typeof body.meetingPoint === "string" ? body.meetingPoint.trim() : "",
    buyerAddress: normalizeAddress(body.buyerAddress),
    sellerAddress: normalizeAddress(body.sellerAddress)
  };
}

function normalizeOrderStatusUpdateRequest(body) {
  return {
    status: normalizeOrderStatus(body.status)
  };
}

function normalizeAddress(address) {
  if (!address || typeof address !== "object") {
    return null;
  }

  return {
    id: typeof address.id === "string" ? address.id : "",
    recipientName: typeof address.recipientName === "string" ? address.recipientName.trim() : "",
    phoneNumber: typeof address.phoneNumber === "string" ? address.phoneNumber.trim() : "",
    addressLine: typeof address.addressLine === "string" ? address.addressLine.trim() : "",
    isDefault: Boolean(address.isDefault)
  };
}

function normalizePaymentMethod(method) {
  if (!method || typeof method !== "object") {
    return null;
  }

  return {
    id: typeof method.id === "string" ? method.id.trim() : "",
    type: typeof method.type === "string" ? method.type.trim() : "",
    label: typeof method.label === "string" ? method.label.trim() : "",
    accountName: typeof method.accountName === "string" ? method.accountName.trim() : "",
    accountNumber: typeof method.accountNumber === "string" ? method.accountNumber.trim() : "",
    bankCode: typeof method.bankCode === "string" ? method.bankCode.trim().toLowerCase() : "",
    bankName: typeof method.bankName === "string" ? method.bankName.trim() : "",
    phoneNumber: typeof method.phoneNumber === "string" ? method.phoneNumber.trim() : "",
    note: typeof method.note === "string" ? method.note.trim() : "",
    isDefault: Boolean(method.isDefault)
  };
}

function normalizeSePayWebhook(body) {
  const code = normalizeTransferReference(firstNonBlankString(body.code));
  const content = firstNonBlankString(body.content);
  const description = firstNonBlankString(body.description);
  const referenceCode = firstNonBlankString(body.referenceCode);
  const transferType = firstNonBlankString(body.transferType)?.toUpperCase() || "";
  const transferReference = (
    code ||
    extractTransferReference(content) ||
    extractTransferReference(description) ||
    extractTransferReference(referenceCode)
  );

  return {
    id: firstNonBlankString(body.id)?.replace(/\s+/g, "") || "",
    gateway: firstNonBlankString(body.gateway),
    transactionDate: firstNonBlankString(body.transactionDate),
    transactionTimestamp: parseSePayTransactionDate(body.transactionDate),
    accountNumber: normalizeAccountNumber(body.accountNumber),
    code,
    content,
    description,
    referenceCode,
    transferContent: transferReference,
    transferType,
    amount: toNumericAmount(body.transferAmount),
    accumulated: toNumericAmount(body.accumulated),
    subAccount: firstNonBlankString(body.subAccount),
    providerStatus: firstNonBlankString(body.status, body.state, body.transactionStatus)?.toUpperCase() || "",
    status: transferType === "IN"
      ? "SUCCESS"
      : firstNonBlankString(body.status, body.state, body.transactionStatus)?.toUpperCase() || "OUT"
  };
}

function firstNonBlankString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function toNumericAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSePayTransactionDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return 0;
  }

  const normalized = value.trim().replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validatePurchaseRequest({
  purchase,
  buyerId,
  sellerId,
  availableQuantity,
  deliveryMethodsAvailable
}) {
  if (!purchase.productId) {
    throw httpError(400, "productId is required");
  }
  if (!Number.isInteger(purchase.quantity) || purchase.quantity <= 0) {
    throw httpError(400, "Invalid quantity selected");
  }
  if (!purchase.deliveryMethod) {
    throw httpError(400, "deliveryMethod is required");
  }
  if (!purchase.paymentMethod) {
    throw httpError(400, "paymentMethod is required");
  }
  if (!sellerId) {
    throw httpError(400, "Seller information is missing");
  }
  if (sellerId === buyerId) {
    throw httpError(403, "You cannot buy your own product");
  }
  if (availableQuantity <= 0) {
    throw httpError(409, "This product is out of stock");
  }
  if (purchase.quantity > availableQuantity) {
    throw httpError(409, `Only ${availableQuantity} item(s) left in stock`);
  }
  if (!deliveryMethodsAvailable.includes(purchase.deliveryMethod)) {
    throw httpError(409, "Selected delivery method is no longer available");
  }

  switch (purchase.deliveryMethod) {
    case "DIRECT_MEET":
      if (!purchase.meetingPoint) {
        throw httpError(400, "Please enter a meeting point");
      }
      break;
    case "BUYER_TO_SELLER":
      if (!purchase.sellerAddress?.addressLine) {
        throw httpError(400, "Seller pickup address is required");
      }
      break;
    case "SELLER_TO_BUYER":
    case "SHIPPING":
      if (!purchase.buyerAddress?.addressLine) {
        throw httpError(400, "Buyer delivery address is required");
      }
      break;
    default:
      throw httpError(400, "Unsupported delivery method");
  }
}

function validateOrderStatusTransition({
  currentStatus,
  nextStatus,
  deliveryMethod
}) {
  if (!SUPPORTED_ORDER_STATUSES.includes(nextStatus)) {
    throw httpError(400, "Unsupported order status");
  }

  if (!currentStatus) {
    throw httpError(409, "Order has an unknown status");
  }

  if (currentStatus === nextStatus) {
    return;
  }

  if (currentStatus === "WAITING_PAYMENT" && nextStatus === "WAITING_CONFIRMATION") {
    return;
  }

  if (TERMINAL_ORDER_STATUSES.includes(currentStatus)) {
    throw httpError(409, `Cannot update an order that is already ${toDisplayStatus(currentStatus)}`);
  }

  if (nextStatus === "CANCELLED") {
    if (!CANCELLABLE_ORDER_STATUSES.includes(currentStatus)) {
      throw httpError(409, `Cannot cancel an order that is ${toDisplayStatus(currentStatus)}`);
    }
    return;
  }

  const expectedNextStatus = nextStatusForOrder({
    currentStatus,
    deliveryMethod
  });

  if (!expectedNextStatus || expectedNextStatus !== nextStatus) {
    throw httpError(
      409,
      `Invalid status transition from ${toDisplayStatus(currentStatus)} to ${toDisplayStatus(nextStatus)}`
    );
  }
}

function nextStatusForOrder({
  currentStatus,
  deliveryMethod
}) {
  switch (currentStatus) {
    case "WAITING_CONFIRMATION":
      return "WAITING_PICKUP";
    case "WAITING_PICKUP":
      return "SHIPPING";
    case "SHIPPING":
      return "DELIVERED";
    case "IN_TRANSIT":
      return "DELIVERED";
    case "OUT_FOR_DELIVERY":
      return "DELIVERED";
    default:
      return null;
  }
}

function shouldRestockInventory(currentStatus, nextStatus) {
  return nextStatus === "CANCELLED" && currentStatus !== "CANCELLED";
}

function shouldRollbackCounters(currentStatus, nextStatus) {
  return nextStatus === "CANCELLED" && currentStatus !== "CANCELLED";
}

function normalizeOrderStatus(rawStatus) {
  const normalized = typeof rawStatus === "string"
    ? rawStatus.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";

  switch (normalized) {
    case "WAITING_PAYMENT":
    case "WAIT_FOR_PAYMENT":
    case "PENDING_PAYMENT":
    case "AWAITING_PAYMENT":
      return "WAITING_PAYMENT";
    case "WAITING":
    case "WAITING_CONFIRMATION":
    case "WAIT_FOR_CONFIRMATION":
    case "CONFIRMED":
    case "PENDING":
    case "PENDING_CONFIRMATION":
      return "WAITING_CONFIRMATION";
    case "WAIT_PICKUP":
    case "WAITING_PICKUP":
    case "WAIT_FOR_PICKUP":
    case "READY_FOR_PICKUP":
    case "PICKUP_READY":
      return "WAITING_PICKUP";
    case "SHIPPING":
    case "SHIPPED":
      return "SHIPPING";
    case "IN_TRANSIT":
      return "IN_TRANSIT";
    case "OUT_FOR_DELIVERY":
      return "OUT_FOR_DELIVERY";
    case "DELIVERED":
    case "COMPLETED":
    case "SUCCESS":
      return "DELIVERED";
    case "CANCELLED":
    case "CANCELED":
    case "FAILED":
      return "CANCELLED";
    default:
      return "";
  }
}

function toDisplayStatus(status) {
  return (status || "UNKNOWN").replace(/_/g, " ");
}

function isTransferPaymentMethod(paymentMethod) {
  const normalized = typeof paymentMethod === "string"
    ? paymentMethod.trim().toUpperCase()
    : "";
  return normalized === "BANK_TRANSFER" || normalized === "MOMO";
}

function buildTransferContent(orderId) {
  return `UM${orderId}`;
}

function extractTransferReference(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const match = value.trim().match(/\bUM[A-Za-z0-9_-]+\b/i);
  return match ? match[0].toUpperCase() : "";
}

function normalizeTransferReference(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  return value.trim().toUpperCase();
}

async function findOrderByTransferContent(transferContent) {
  const normalizedReference = typeof transferContent === "string"
    ? transferContent.trim().toUpperCase()
    : "";
  if (!normalizedReference) {
    return null;
  }

  const orderId = normalizedReference.startsWith("UM")
    ? normalizedReference.slice(2)
    : "";
  if (orderId) {
    const directOrderSnap = await db.collection("orders").doc(orderId).get();
    if (directOrderSnap.exists) {
      const directOrder = directOrderSnap.data() || {};
      if (
        normalizeOrderStatus(directOrder.status) === "WAITING_PAYMENT" &&
        String(directOrder.transferContent || "").trim().toUpperCase() === normalizedReference
      ) {
        return { id: orderId, ...directOrder };
      }
    }
  }

  const snapshot = await db.collection("orders")
    .where("transferContent", "==", normalizedReference)
    .limit(5)
    .get();

  const match = snapshot.docs.find((document) => {
    const order = document.data() || {};
    return normalizeOrderStatus(order.status) === "WAITING_PAYMENT";
  });

  return match ? { id: match.id, ...(match.data() || {}) } : null;
}

function isPendingPaymentExpired(order) {
  const paymentExpiresAt = toMillis(order?.paymentExpiresAt);
  return paymentExpiresAt > 0 && Date.now() >= paymentExpiresAt;
}

async function expireOverdueTransferOrdersForUser(userId) {
  if (!userId) return;
  const now = Date.now();
  const lastCleanupAt = expiredTransferCleanupByUser.get(userId) || 0;
  if (now - lastCleanupAt < EXPIRED_TRANSFER_ORDER_CLEANUP_COOLDOWN_MS) {
    return;
  }
  expiredTransferCleanupByUser.set(userId, now);

  const snapshot = await db.collection("users").doc(userId).collection("orders")
    .where("status", "==", "WAITING_PAYMENT")
    .limit(MAX_PENDING_TRANSFER_ORDERS_PER_CLEANUP)
    .get();

  const expiredOrders = snapshot.docs
    .map((document) => ({ id: document.id, ...(document.data() || {}) }))
    .filter((order) => isPendingPaymentExpired(order));

  if (expiredOrders.length === 0) {
    return;
  }

  await Promise.all(
    expiredOrders.map((order) =>
      runBestEffort(
        () => expirePendingTransferOrder({ orderId: order.id, order }),
        `Failed to expire overdue transfer order ${order.id}`
      )
    )
  );
}

async function expirePendingTransferOrder({ orderId, order }) {
  const paymentExpiresAt = toMillis(order?.paymentExpiresAt);

  return db.runTransaction(async (transaction) => {
    const orderRef = db.collection("orders").doc(orderId);
    const latestOrderSnap = await transaction.get(orderRef);
    if (!latestOrderSnap.exists) {
      return {
        status: "CANCELLED",
        paymentExpiresAt
      };
    }

    const latestOrder = latestOrderSnap.data() || {};
    const buyerId = normalizeActorId(latestOrder.buyerId);
    const sellerId = normalizeActorId(latestOrder.sellerId);
    const productId = typeof latestOrder.productId === "string" ? latestOrder.productId.trim() : "";
    const quantity = Number.isFinite(Number(latestOrder.quantity)) && Number(latestOrder.quantity) > 0
      ? Number(latestOrder.quantity)
      : 1;
    const currentStatus = normalizeOrderStatus(latestOrder.status);
    if (currentStatus && currentStatus !== "WAITING_PAYMENT") {
      return {
        status: currentStatus,
        paymentExpiresAt: toMillis(latestOrder.paymentExpiresAt)
      };
    }

    // Remove expired unpaid order from all order collections.
    transaction.delete(orderRef);
    if (buyerId) {
      transaction.delete(
        db.collection("users").doc(buyerId).collection("orders").doc(orderId)
      );
    }
    if (sellerId) {
      transaction.delete(
        db.collection("users").doc(sellerId).collection("orders").doc(orderId)
      );
    }

    if (productId) {
      const productRef = db.collection("products").doc(productId);
      const productSnap = await transaction.get(productRef);
      if (productSnap.exists) {
        const product = productSnap.data() || {};
        const availableQuantity = Math.max(0, Number(product.quantityAvailable || 0));
        transaction.set(
          productRef,
          {
            quantityAvailable: availableQuantity + quantity,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }
    }

    return {
      status: "CANCELLED",
      paymentExpiresAt
    };
  });
}

async function confirmTransferPayment({ orderId, order, paymentMatch }) {
  const buyerId = normalizeActorId(order.buyerId);
  const sellerId = normalizeActorId(order.sellerId);
  const productName = typeof order.productName === "string" ? order.productName : "";
  const buyerName = typeof order.buyerName === "string" ? order.buyerName : "Student Buyer";
  const paymentExpiresAt = toMillis(order.paymentExpiresAt);

  const result = await db.runTransaction(async (transaction) => {
    const orderRef = db.collection("orders").doc(orderId);
    const latestOrderSnap = await transaction.get(orderRef);
    if (!latestOrderSnap.exists) {
      throw httpError(404, "Order not found");
    }

    const latestOrder = latestOrderSnap.data() || {};
    const currentStatus = normalizeOrderStatus(latestOrder.status);
    logInfo("confirm-transfer", "Loaded latest order state", {
      orderId,
      currentStatus,
      hasBuyerId: Boolean(buyerId),
      hasSellerId: Boolean(sellerId),
      paymentMatchId: paymentMatch?.id || "",
      paymentMatchReference: paymentMatch?.reference || ""
    });
    if (!currentStatus) {
      throw httpError(409, "Order has an unknown status");
    }
    if (currentStatus !== "WAITING_PAYMENT") {
      logInfo("confirm-transfer", "Skip state transition because order is not WAITING_PAYMENT", {
        orderId,
        currentStatus
      });
      return {
        orderId,
        buyerId,
        sellerId,
        buyerName,
        productName,
        status: currentStatus,
        wasChanged: false,
        paymentConfirmedAt: toMillis(latestOrder.paymentConfirmedAt),
        paymentExpiresAt: toMillis(latestOrder.paymentExpiresAt)
      };
    }

    const paymentConfirmedAt = admin.firestore.FieldValue.serverTimestamp();
    const orderStatusPayload = {
      status: "WAITING_CONFIRMATION",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentConfirmedAt,
      paymentExpiresAt: 0,
      paymentTransactionId: paymentMatch.id || "",
      paymentTransactionRef: paymentMatch.reference || ""
    };

    transaction.set(orderRef, orderStatusPayload, { merge: true });
    if (buyerId) {
      transaction.set(
        db.collection("users").doc(buyerId).collection("orders").doc(orderId),
        orderStatusPayload,
        { merge: true }
      );
      transaction.set(
        db.collection("users").doc(buyerId),
        { boughtCount: admin.firestore.FieldValue.increment(1) },
        { merge: true }
      );
    }
    if (sellerId) {
      transaction.set(
        db.collection("users").doc(sellerId).collection("orders").doc(orderId),
        orderStatusPayload,
        { merge: true }
      );
      transaction.set(
        db.collection("users").doc(sellerId),
        { soldCount: admin.firestore.FieldValue.increment(1) },
        { merge: true }
      );
    }

    return {
      orderId,
      buyerId,
      sellerId,
      buyerName,
      productName,
      status: "WAITING_CONFIRMATION",
      wasChanged: true,
      paymentConfirmedAt: Date.now(),
      paymentExpiresAt: 0
    };
  });

  return result;
}

async function finalizeTransferPayment(result) {
  if (!result?.wasChanged) {
    return;
  }

  await runBestEffort(async () => {
    await sendNotificationToUser(result.sellerId, {
      title: "Payment received",
      body: `${result.buyerName} completed payment for ${result.productName || "your item"}.`,
      data: {
        type: "order_paid",
        orderId: result.orderId,
        status: result.status
      }
    });
  }, "Failed to send seller payment notification");

  await runBestEffort(async () => {
    await sendNotificationToUser(result.buyerId, {
      title: "Payment confirmed",
      body: `Your transfer for ${result.productName || "your order"} has been verified.`,
      data: {
        type: "payment_confirmed",
        orderId: result.orderId,
        status: result.status
      }
    });
  }, "Failed to send buyer payment notification");
}

async function findMatchingTransferPayment({ orderId, order }) {
  const rawExpectedContent = (
    typeof order.transferContent === "string" && order.transferContent.trim()
      ? order.transferContent
      : buildTransferContent(orderId)
  ).trim();
  const expectedContent = normalizeTransferReference(rawExpectedContent);
  const expectedAmount = Number(order.total || order.totalAmount || 0);
  const expectedAccount = normalizeAccountNumber(order?.paymentMethodDetails?.accountNumber);
  logInfo("match-transfer", "Start finding transfer payment", {
    orderId,
    expectedContent,
    expectedAmount,
    expectedAccount
  });

  const sepayCandidates = await fetchSePayTransactionsForPaymentCheck();
  const matchedFromSePay = findMatchingCandidate({
    orderId,
    expectedContent,
    expectedAmount,
    expectedAccount,
    candidates: sepayCandidates
  });

  if (matchedFromSePay) {
    await persistMatchedSePayTransaction(matchedFromSePay);
    logInfo("match-transfer", "Matched payment from SePay transactions API", {
      orderId,
      sepayTransactionId: matchedFromSePay.providerTransactionId,
      amount: matchedFromSePay.amount,
      reference: matchedFromSePay.reference
    });

    return {
      id: matchedFromSePay.id,
      reference: matchedFromSePay.reference,
      amount: matchedFromSePay.amount,
      status: matchedFromSePay.status,
      receiverAccount: matchedFromSePay.receiverAccount
    };
  }

  const fallbackCandidates = await findTransferCandidatesFromFirestore({
    rawExpectedContent,
    expectedContent
  });
  const matchedCandidate = findMatchingCandidate({
    orderId,
    expectedContent,
    expectedAmount,
    expectedAccount,
    candidates: fallbackCandidates
  });

  logInfo("match-transfer", "Finished matching transfer payment", {
    orderId,
    candidateCount: sepayCandidates.length + fallbackCandidates.length,
    matchedTransactionId: matchedCandidate?.id || "",
    matchedReference: matchedCandidate?.reference || ""
  });

  return matchedCandidate;
}

async function fetchSePayTransactionsForPaymentCheck() {
  const token = (
    process.env.SEPAY_USER_API_TOKEN
    || process.env.SEPAY_API_TOKEN
    || process.env.SEPAY_TOKEN
    || ""
  ).trim();
  if (!token) {
    logWarn("match-transfer", "SePay API token is missing; skip direct transaction check");
    return [];
  }

  const accountNumber = (process.env.SEPAY_CHECK_ACCOUNT_NUMBER || DEFAULT_SEPAY_CHECK_ACCOUNT_NUMBER).trim();
  const limitRaw = Number(process.env.SEPAY_CHECK_LIMIT || DEFAULT_SEPAY_CHECK_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_SEPAY_CHECK_LIMIT;
  const url = `${SEPAY_TRANSACTIONS_LIST_URL}?${new URLSearchParams({
    account_number: accountNumber,
    limit: String(limit)
  }).toString()}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      logWarn("match-transfer", "SePay API request failed", {
        status: response.status,
        body: body.slice(0, 300)
      });
      return [];
    }

    const payload = await response.json();
    const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
    const normalized = transactions.map((item) => normalizeSePayListTransaction(item)).filter(Boolean);
    logInfo("match-transfer", "Fetched transactions from SePay API", {
      accountNumber,
      requestedLimit: limit,
      receivedCount: normalized.length
    });
    return normalized;
  } catch (error) {
    logWarn("match-transfer", "Failed to call SePay transactions API", {
      message: error?.message || String(error)
    });
    return [];
  }
}

function normalizeSePayListTransaction(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const providerTransactionId = firstNonBlankString(
    item.id,
    item.transaction_id,
    item.transactionId,
    item.reference_number,
    item.referenceNumber
  );
  const referenceSource = firstNonBlankString(
    item.transaction_content,
    item.transactionContent,
    item.content,
    item.description,
    item.addInfo,
    item.code
  );
  const extractedReference = extractTransferReference(referenceSource) || normalizeTransferReference(item.code);
  const amount = toNumericAmount(
    item.amount_in
    || item.amountIn
    || item.amount
    || item.transferAmount
  );
  const accountNumber = normalizeAccountNumber(
    item.account_number
    || item.accountNumber
    || item.receiverAccount
    || item.receiverAccountNumber
  );

  return {
    id: providerTransactionId ? `sepay_poll_${providerTransactionId}` : "",
    providerTransactionId,
    reference: extractedReference,
    amount,
    receiverAccount: accountNumber,
    status: "SUCCESS",
    raw: item
  };
}

async function persistMatchedSePayTransaction(candidate) {
  if (!candidate?.id) {
    return;
  }

  const payload = {
    provider: "SEPAY",
    providerTransactionId: candidate.providerTransactionId || "",
    receiverAccount: candidate.receiverAccount || "",
    transferContent: candidate.reference || "",
    reference: candidate.reference || "",
    amount: candidate.amount || 0,
    transferAmount: candidate.amount || 0,
    status: candidate.status || "SUCCESS",
    providerStatus: candidate.status || "SUCCESS",
    raw: candidate.raw || {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection("paymentTransactions").doc(candidate.id).set(payload, { merge: true });
}

async function findTransferCandidatesFromFirestore({ rawExpectedContent, expectedContent }) {
  const queryReferences = Array.from(new Set(
    [rawExpectedContent, expectedContent].filter((value) => typeof value === "string" && value.trim())
  ));
  const candidates = [];

  for (const collectionName of TRANSFER_TRANSACTION_COLLECTIONS) {
    for (const fieldName of TRANSFER_TRANSACTION_REFERENCE_FIELDS) {
      for (const queryReference of queryReferences) {
        let snapshot;
        try {
          snapshot = await db.collection(collectionName)
            .where(fieldName, "==", queryReference)
            .limit(10)
            .get();
        } catch (_error) {
          snapshot = null;
        }

        snapshot?.forEach((document) => {
          candidates.push({
            id: document.id,
            path: document.ref.path,
            ...normalizeTransferTransaction(document.data() || {})
          });
        });
      }
    }
  }

  return candidates.filter((candidate, index, collection) =>
    collection.findIndex((item) => item.path === candidate.path) === index
  );
}

function findMatchingCandidate({
  orderId,
  expectedContent,
  expectedAmount,
  expectedAccount,
  candidates
}) {
  return (candidates || []).find((candidate) => {
    if (!candidate.reference || normalizeTransferReference(candidate.reference) !== expectedContent) {
      return false;
    }
    if (candidate.status && !SUCCESSFUL_PAYMENT_STATUSES.includes(candidate.status)) {
      return false;
    }
    if (expectedAmount > 0 && Math.abs(Number(candidate.amount || 0) - expectedAmount) > 1) {
      return false;
    }
    if (expectedAccount && candidate.receiverAccount && candidate.receiverAccount !== expectedAccount) {
      logWarn("match-transfer", "Receiver account mismatch, but keeping candidate because reference+amount matched", {
        orderId,
        expectedAccount,
        candidateReceiverAccount: candidate.receiverAccount,
        candidateId: candidate.id || ""
      });
    }
    return true;
  }) || null;
}

function normalizeTransferTransaction(data) {
  const rawStatus = typeof data.status === "string"
    ? data.status
    : typeof data.state === "string"
      ? data.state
      : typeof data.transactionStatus === "string"
        ? data.transactionStatus
        : "";

  const rawReference = data.transferContent
    || data.reference
    || data.description
    || data.content
    || data.addInfo
    || data.memo
    || data.message
    || data?.metadata?.transferContent
    || data?.metadata?.reference
    || "";

  return {
    amount: Number(
      data.amount
        || data.value
        || data.totalAmount
        || data.creditAmount
        || data?.transaction?.amount
        || 0
    ),
    receiverAccount: normalizeAccountNumber(
      data.receiverAccount
        || data.receiverAccountNumber
        || data.accountNumber
        || data.toAccountNumber
        || data.creditAccount
        || data?.receiver?.accountNumber
        || data?.beneficiary?.accountNumber
    ),
    reference: normalizeTransferReference(rawReference),
    status: typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : ""
  };
}

function normalizeAccountNumber(value) {
  return typeof value === "string"
    ? value.replace(/\s+/g, "").trim()
    : "";
}

function buildBuyerOrderStatusNotification({
  status,
  orderId,
  productName,
  sellerName
}) {
  const itemName = productName || "your order";
  const storeName = sellerName || "the seller";

  switch (status) {
    case "WAITING_PICKUP":
      return {
        title: "Order confirmed",
        body: `${storeName} confirmed your order for ${itemName}.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    case "SHIPPING":
      return {
        title: "Delivery started",
        body: `${itemName} is on the way from ${storeName}.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    case "IN_TRANSIT":
      return {
        title: "Order in transit",
        body: `${itemName} is on the way.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    case "OUT_FOR_DELIVERY":
      return {
        title: "Order out for delivery",
        body: `${itemName} is heading to you now.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    case "DELIVERED":
      return {
        title: "Order delivered",
        body: `${itemName} has been marked as delivered.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    case "CANCELLED":
      return {
        title: "Order cancelled",
        body: `${storeName} cancelled your order for ${itemName}.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    default:
      return {
        title: "Order updated",
        body: `${itemName} was updated by ${storeName}.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
  }
}

async function sendNotificationToUser(receiverId, payload) {
  if (!receiverId) return 0;

  const receiverSnap = await db.collection("users").doc(receiverId).get();
  if (!receiverSnap.exists) return 0;

  const receiverData = receiverSnap.data() || {};
  const { tokens, primaryToken } = extractUserTokens(receiverData);
  console.log("Receiver tokens", {
    receiverId,
    tokenCount: tokens.length,
    tokenPrefixes: tokens.map((token) => token.slice(0, 12))
  });

  if (tokens.length === 0) return 0;

  const title = typeof payload?.title === "string" ? payload.title : "UniMarket";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const data = sanitizeNotificationData({
    title,
    body,
    ...(payload?.data || {})
  });

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title,
      body
    },
    data,
    android: {
      priority: "high"
    }
  });

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

  return response.successCount;
}

function extractUserTokens(userData) {
  const rawTokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  const primaryToken = typeof userData.fcmToken === "string" ? userData.fcmToken : "";
  const tokens = Array.from(new Set([...rawTokens, primaryToken].filter(Boolean)));

  return {
    primaryToken,
    tokens
  };
}

function sanitizeNotificationData(data) {
  return Object.entries(data || {}).reduce((accumulator, [key, value]) => {
    if (!key || value === undefined || value === null) return accumulator;
    accumulator[key] = String(value);
    return accumulator;
  }, {});
}

async function runBestEffort(task, label) {
  try {
    await task();
  } catch (error) {
    console.error(label, error);
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const PLATFORM_FEE = 1500;
const SHIPPING_FEE = 30000;
const TRANSFER_PAYMENT_WINDOW_MS = 10 * 60 * 1000;
const SUPPORTED_ORDER_STATUSES = [
  "WAITING_PAYMENT",
  "WAITING_CONFIRMATION",
  "WAITING_PICKUP",
  "SHIPPING",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED"
];
const TERMINAL_ORDER_STATUSES = ["DELIVERED", "CANCELLED"];
const CANCELLABLE_ORDER_STATUSES = [
  "WAITING_PAYMENT",
  "WAITING_CONFIRMATION",
  "WAITING_PICKUP",
  "SHIPPING",
  "IN_TRANSIT"
];
const TRANSFER_TRANSACTION_COLLECTIONS = [
  "paymentTransactions",
  "bankTransactions",
  "transactions"
];
const TRANSFER_TRANSACTION_REFERENCE_FIELDS = [
  "transferContent",
  "reference",
  "description",
  "content",
  "addInfo"
];
const SUCCESSFUL_PAYMENT_STATUSES = [
  "SUCCESS",
  "SUCCEEDED",
  "COMPLETED",
  "PAID"
];
const EXPIRED_TRANSFER_ORDER_CLEANUP_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_PENDING_TRANSFER_ORDERS_PER_CLEANUP = 20;
const expiredTransferCleanupByUser = new Map();
const SEPAY_TRANSACTIONS_LIST_URL = "https://my.sepay.vn/userapi/transactions/list";
const DEFAULT_SEPAY_CHECK_ACCOUNT_NUMBER = "0356433860";
const DEFAULT_SEPAY_CHECK_LIMIT = 20;
