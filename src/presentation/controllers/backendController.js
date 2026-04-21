function createBackendController(useCases) {
  const handle = (fn, errorLabel) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error(errorLabel, error);
      const status = Number(error?.status) || 500;
      return res.status(status).json({ error: error?.message || 'Internal server error' });
    }
  };

  return {
    health: (_req, res) => {
      res.json({ ok: true });
    },

    sendOtp: handle(async (req, res) => {
      const result = await useCases.sendOtp({
        phoneNumber: req.body?.phoneNumber
      });
      res.json(result);
    }, 'Failed to send OTP'),

    verifyOtp: handle(async (req, res) => {
      const result = await useCases.verifyOtp({
        phoneNumber: req.body?.phoneNumber,
        code: req.body?.code
      });
      res.json(result);
    }, 'Failed to verify OTP'),

    sepayWebhook: handle(async (req, res) => {
      const result = await useCases.processSePayWebhook({
        headers: req.headers,
        body: req.body
      });
      res.status(200).json(result);
    }, 'Failed to process SePay webhook'),

    chatNotification: handle(async (req, res) => {
      const decodedToken = await useCases.requireAuthFromHeader(req.headers.authorization);
      const result = await useCases.sendChatNotification({
        senderId: decodedToken.uid,
        body: req.body
      });
      res.json(result);
    }, 'Failed to send chat notification'),

    buyNowCheckout: handle(async (req, res) => {
      const decodedToken = await useCases.requireAuthFromHeader(req.headers.authorization);
      const result = await useCases.confirmBuyNowPurchase({ decodedToken, body: req.body });
      res.json(result);
    }, 'Failed to confirm buy now purchase'),

    updateOrderStatus: handle(async (req, res) => {
      const decodedToken = await useCases.requireAuthFromHeader(req.headers.authorization);
      const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
      const result = await useCases.updateOrderStatus({
        actorId: decodedToken.uid,
        orderId,
        body: req.body
      });
      res.json(result);
    }, 'Failed to update order status'),

    checkOrderPayment: handle(async (req, res) => {
      const decodedToken = await useCases.requireAuthFromHeader(req.headers.authorization);
      const orderId = typeof req.params.orderId === 'string' ? req.params.orderId.trim() : '';
      const result = await useCases.checkTransferPayment({
        buyerId: decodedToken.uid,
        orderId
      });
      res.json(result);
    }, 'Failed to check transfer payment'),

    getBuyerOrders: handle(async (req, res) => {
      const decodedToken = await useCases.requireAuthFromHeader(req.headers.authorization);
      const result = await useCases.getBuyerOrders(decodedToken.uid);
      res.json(result);
    }, 'Failed to load buyer orders'),

    getSellerOrders: handle(async (req, res) => {
      const decodedToken = await useCases.requireAuthFromHeader(req.headers.authorization);
      const result = await useCases.getSellerOrders(decodedToken.uid);
      res.json(result);
    }, 'Failed to load seller orders'),

    lockUser: handle(async (req, res) => {
      const decodedToken = await useCases.requireAdminAuthFromHeader(req.headers.authorization);
      const targetUid = typeof req.params.uid === 'string' ? req.params.uid.trim() : '';
      const disabled = Boolean(req.body?.disabled);
      const result = await useCases.setUserLock({
        actorId: decodedToken.uid,
        targetUid,
        disabled
      });
      res.json(result);
    }, 'Failed to lock/unlock user'),

    deleteUser: handle(async (req, res) => {
      const decodedToken = await useCases.requireAdminAuthFromHeader(req.headers.authorization);
      const targetUid = typeof req.params.uid === 'string' ? req.params.uid.trim() : '';
      const result = await useCases.deleteUser({
        actorId: decodedToken.uid,
        targetUid
      });
      res.json(result);
    }, 'Failed to delete user'),

    moderateProduct: handle(async (req, res) => {
      const decodedToken = await useCases.requireAdminAuthFromHeader(req.headers.authorization);
      const productId = typeof req.params.productId === 'string' ? req.params.productId.trim() : '';
      const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      const result = await useCases.moderateProduct({
        actorId: decodedToken.uid,
        productId,
        action,
        reason
      });
      res.json(result);
    }, 'Failed to moderate product')
  };
}

module.exports = {
  createBackendController
};
