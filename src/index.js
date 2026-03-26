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
      const sellerRef = db.collection("users").doc(sellerId);
      const buyerOrderRef = buyerRef.collection("orders").doc(orderRef.id);
      const sellerOrderRef = sellerRef.collection("orders").doc(orderRef.id);
      const orderPayload = {
        orderId: orderRef.id,
        source: "buy_now",
        status: "WAITING_CONFIRMATION",
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
        deliveryMethod: purchase.deliveryMethod,
        meetingPoint: purchase.meetingPoint || "",
        buyerAddress: purchase.buyerAddress || null,
        sellerAddress: purchase.sellerAddress || null,
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

      return {
        orderId: orderRef.id,
        remainingQuantity,
        sellerId,
        buyerName: decodedToken.name || decodedToken.email || "Student Buyer",
        productName
      };
    });

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

      if (!sellerId) {
        throw httpError(400, "Order seller information is missing");
      }
      if (sellerId !== actorId) {
        throw httpError(403, "You can only update your own orders");
      }

      validateOrderStatusTransition({
        currentStatus,
        nextStatus,
        deliveryMethod
      });

      if (currentStatus === nextStatus) {
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

app.get("/orders/buyer", async (req, res) => {
  try {
    const decodedToken = await requireAuth(req);
    const orders = await fetchOrdersForActor({
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

async function requireAuth(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) {
    throw httpError(401, "Missing Firebase ID token");
  }

  return admin.auth().verifyIdToken(idToken);
}

async function fetchOrdersForActor({
  primaryField,
  fallbackField,
  userId,
  includeUserScopedCollection
}) {
  const mergedOrders = [];

  mergedOrders.push(
    ...(await fetchRootOrders(userId, primaryField, fallbackField))
  );

  if (includeUserScopedCollection) {
    mergedOrders.push(...(await fetchUserScopedOrders(userId)));
  }

  return mergedOrders
    .filter(Boolean)
    .reduce((accumulator, order) => {
      const key = order.documentPath || order.id;
      if (!accumulator.some((item) => (item.documentPath || item.id) === key)) {
        accumulator.push(order);
      }
      return accumulator;
    }, [])
    .sort((left, right) => Math.max(right.updatedAt, right.createdAt) - Math.max(left.updatedAt, left.createdAt));
}

async function fetchRootOrders(userId, primaryField, fallbackField) {
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
    .filter(Boolean);
}

async function fetchUserScopedOrders(userId) {
  const snapshot = await db.collection("users").doc(userId).collection("orders").get();
  return snapshot.docs.map(mapOrderDocument).filter(Boolean);
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
      meetingPoint: typeof order.meetingPoint === "string" ? order.meetingPoint : "",
      buyerAddress: mapAddressPayload(order.buyerAddress),
      sellerAddress: mapAddressPayload(order.sellerAddress),
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

function normalizePurchaseRequest(body) {
  return {
    productId: typeof body.productId === "string" ? body.productId.trim() : "",
    quantity: Number(body.quantity || 0),
    deliveryMethod: typeof body.deliveryMethod === "string" ? body.deliveryMethod.trim() : "",
    paymentMethod: typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : "",
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
      switch ((deliveryMethod || "").trim().toUpperCase()) {
        case "DIRECT_MEET":
        case "BUYER_TO_SELLER":
          return "WAITING_PICKUP";
        case "SELLER_TO_BUYER":
          return "OUT_FOR_DELIVERY";
        case "SHIPPING":
          return "SHIPPING";
        default:
          return "WAITING_PICKUP";
      }
    case "WAITING_PICKUP":
      return "DELIVERED";
    case "SHIPPING":
      return "IN_TRANSIT";
    case "IN_TRANSIT":
      return "OUT_FOR_DELIVERY";
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
        title: "Order ready for pickup",
        body: `${itemName} is ready for pickup from ${storeName}.`,
        data: {
          type: "order_status_updated",
          orderId,
          status
        }
      };
    case "SHIPPING":
      return {
        title: "Order shipped",
        body: `${itemName} has been handed to the carrier by ${storeName}.`,
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
const SUPPORTED_ORDER_STATUSES = [
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
  "WAITING_CONFIRMATION",
  "WAITING_PICKUP",
  "SHIPPING",
  "IN_TRANSIT"
];
