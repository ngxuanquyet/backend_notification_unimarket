class CommerceService {
  constructor(legacy) {
    this.legacy = legacy;
  }

  confirmBuyNowPurchase(input) {
    return this.legacy.confirmBuyNowPurchase(input);
  }

  updateOrderStatus(input) {
    return this.legacy.updateOrderStatus(input);
  }

  checkTransferPayment(input) {
    return this.legacy.checkTransferPayment(input);
  }

  getBuyerOrders(userId) {
    return this.legacy.getBuyerOrders(userId);
  }

  getSellerOrders(userId) {
    return this.legacy.getSellerOrders(userId);
  }
}

module.exports = {
  CommerceService
};
