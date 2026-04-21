function registerRoutes(app, controller) {
  app.get('/health', controller.health);
  app.post('/auth/otp/send', controller.sendOtp);
  app.post('/auth/otp/verify', controller.verifyOtp);

  app.post('/webhooks/sepay', controller.sepayWebhook);
  app.post('/notifications/chat', controller.chatNotification);

  app.post('/checkout/buy-now', controller.buyNowCheckout);
  app.post('/orders/:orderId/status', controller.updateOrderStatus);
  app.post('/orders/:orderId/payment/check', controller.checkOrderPayment);
  app.get('/orders/buyer', controller.getBuyerOrders);
  app.get('/orders/seller', controller.getSellerOrders);

  app.post('/admin/users/:uid/lock', controller.lockUser);
  app.delete('/admin/users/:uid', controller.deleteUser);
  app.post('/admin/products/:productId/moderate', controller.moderateProduct);
}

module.exports = {
  registerRoutes
};
