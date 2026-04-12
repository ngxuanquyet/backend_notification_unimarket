class AdminProductService {
  constructor(legacy) {
    this.legacy = legacy;
  }

  moderateProduct(input) {
    return this.legacy.moderateProduct(input);
  }
}

module.exports = {
  AdminProductService
};
