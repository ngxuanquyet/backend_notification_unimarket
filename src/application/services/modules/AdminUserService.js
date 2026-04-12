class AdminUserService {
  constructor(legacy) {
    this.legacy = legacy;
  }

  setUserLock(input) {
    return this.legacy.setUserLock(input);
  }

  deleteUser(input) {
    return this.legacy.deleteUser(input);
  }
}

module.exports = {
  AdminUserService
};
