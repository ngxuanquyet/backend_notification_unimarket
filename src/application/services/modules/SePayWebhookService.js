class SePayWebhookService {
  constructor(legacy) {
    this.legacy = legacy;
  }

  processSePayWebhook(input) {
    return this.legacy.processSePayWebhook(input);
  }
}

module.exports = {
  SePayWebhookService
};
