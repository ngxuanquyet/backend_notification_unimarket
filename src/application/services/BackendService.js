const { LegacyBackendService } = require('./legacy/LegacyBackendService');
const { AuthService } = require('./modules/AuthService');
const { AdminUserService } = require('./modules/AdminUserService');
const { AdminProductService } = require('./modules/AdminProductService');
const { NotificationService } = require('./modules/NotificationService');
const { CommerceService } = require('./modules/CommerceService');
const { SePayWebhookService } = require('./modules/SePayWebhookService');

class BackendService {
  constructor(dependencies) {
    const legacy = new LegacyBackendService(dependencies);

    this.authService = new AuthService(legacy);
    this.adminUserService = new AdminUserService(legacy);
    this.adminProductService = new AdminProductService(legacy);
    this.notificationService = new NotificationService(legacy);
    this.commerceService = new CommerceService(legacy);
    this.sepayWebhookService = new SePayWebhookService(legacy);
  }

  processSePayWebhook(input) {
    return this.sepayWebhookService.processSePayWebhook(input);
  }

  sendChatNotification(input) {
    return this.notificationService.sendChatNotification(input);
  }

  confirmBuyNowPurchase(input) {
    return this.commerceService.confirmBuyNowPurchase(input);
  }

  updateOrderStatus(input) {
    return this.commerceService.updateOrderStatus(input);
  }

  checkTransferPayment(input) {
    return this.commerceService.checkTransferPayment(input);
  }

  getBuyerOrders(userId) {
    return this.commerceService.getBuyerOrders(userId);
  }

  getSellerOrders(userId) {
    return this.commerceService.getSellerOrders(userId);
  }

  setUserLock(input) {
    return this.adminUserService.setUserLock(input);
  }

  deleteUser(input) {
    return this.adminUserService.deleteUser(input);
  }

  moderateProduct(input) {
    return this.adminProductService.moderateProduct(input);
  }

  requireAuthFromHeader(authorizationHeader) {
    return this.authService.requireAuthFromHeader(authorizationHeader);
  }

  requireAdminAuthFromHeader(authorizationHeader) {
    return this.authService.requireAdminAuthFromHeader(authorizationHeader);
  }
}

module.exports = {
  BackendService
};
