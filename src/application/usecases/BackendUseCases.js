class BackendUseCases {
  constructor(service) {
    this.service = service;
  }

  processSePayWebhook(input) {
    return this.service.processSePayWebhook(input);
  }

  sendChatNotification(input) {
    return this.service.sendChatNotification(input);
  }

  confirmBuyNowPurchase(input) {
    return this.service.confirmBuyNowPurchase(input);
  }

  updateOrderStatus(input) {
    return this.service.updateOrderStatus(input);
  }

  checkTransferPayment(input) {
    return this.service.checkTransferPayment(input);
  }

  getBuyerOrders(userId) {
    return this.service.getBuyerOrders(userId);
  }

  getSellerOrders(userId) {
    return this.service.getSellerOrders(userId);
  }

  setUserLock(input) {
    return this.service.setUserLock(input);
  }

  deleteUser(input) {
    return this.service.deleteUser(input);
  }

  moderateProduct(input) {
    return this.service.moderateProduct(input);
  }

  requireAuthFromHeader(header) {
    return this.service.requireAuthFromHeader(header);
  }

  requireAdminAuthFromHeader(header) {
    return this.service.requireAdminAuthFromHeader(header);
  }
}

module.exports = {
  BackendUseCases
};
