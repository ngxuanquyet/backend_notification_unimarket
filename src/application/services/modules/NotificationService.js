class NotificationService {
  constructor(legacy) {
    this.legacy = legacy;
  }

  sendChatNotification(input) {
    return this.legacy.sendChatNotification(input);
  }
}

module.exports = {
  NotificationService
};
