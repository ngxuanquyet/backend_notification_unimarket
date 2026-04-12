class AuthService {
  constructor(legacy) {
    this.legacy = legacy;
  }

  requireAuthFromHeader(authorizationHeader) {
    return this.legacy.requireAuthFromHeader(authorizationHeader);
  }

  requireAdminAuthFromHeader(authorizationHeader) {
    return this.legacy.requireAdminAuthFromHeader(authorizationHeader);
  }
}

module.exports = {
  AuthService
};
