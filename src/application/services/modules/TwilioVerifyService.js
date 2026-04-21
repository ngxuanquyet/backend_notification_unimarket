const twilio = require('twilio');

class TwilioVerifyService {
  constructor() {
    this.accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    this.authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    this.verifyServiceSid = (process.env.TWILIO_VERIFY_SERVICE_SID || '').trim();
    this.twilioRegion = (process.env.TWILIO_REGION || '').trim().toLowerCase();
    this.twilioEdge = (process.env.TWILIO_EDGE || '').trim().toLowerCase();
    const clientOptions = {};
    if (this.twilioRegion) {
      clientOptions.region = this.twilioRegion;
    }
    if (this.twilioEdge) {
      clientOptions.edge = this.twilioEdge;
    }
    this.client =
      this.accountSid && this.authToken
        ? twilio(this.accountSid, this.authToken, clientOptions)
        : null;
    this.logConfiguration();
  }

  async sendOtp(input) {
    const phoneNumber = normalizePhoneNumber(input?.phoneNumber);
    if (!phoneNumber) {
      throw httpError(400, 'phoneNumber is required in E.164 format, for example +84901234567');
    }
    this.assertConfigured();

    const result = await this.client.verify.v2
      .services(this.verifyServiceSid)
      .verifications.create({
        to: phoneNumber,
        channel: 'sms'
      });

    return {
      success: true,
      sid: result.sid,
      status: result.status,
      to: result.to
    };
  }

  async verifyOtp(input) {
    const phoneNumber = normalizePhoneNumber(input?.phoneNumber);
    const code = normalizeOtpCode(input?.code);
    if (!phoneNumber) {
      throw httpError(400, 'phoneNumber is required in E.164 format, for example +84901234567');
    }
    if (!code) {
      throw httpError(400, 'code is required');
    }
    this.assertConfigured();

    const result = await this.client.verify.v2
      .services(this.verifyServiceSid)
      .verificationChecks.create({
        to: phoneNumber,
        code
      });

    return {
      success: result.status === 'approved',
      status: result.status,
      to: result.to
    };
  }

  assertConfigured() {
    if (!this.accountSid || !this.authToken || !this.verifyServiceSid || !this.client) {
      throw httpError(
        500,
        'Twilio Verify is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID'
      );
    }
  }

  logConfiguration() {
    console.log('[twilio-verify] config', {
      hasAccountSid: Boolean(this.accountSid),
      accountSidMask: maskValue(this.accountSid),
      hasAuthToken: Boolean(this.authToken),
      authTokenLength: this.authToken.length,
      authTokenMask: maskValue(this.authToken),
      hasVerifyServiceSid: Boolean(this.verifyServiceSid),
      verifyServiceSidMask: maskValue(this.verifyServiceSid),
      region: this.twilioRegion || 'default',
      edge: this.twilioEdge || 'default'
    });
  }
}

function normalizePhoneNumber(rawPhoneNumber) {
  if (typeof rawPhoneNumber !== 'string') return '';
  const normalized = rawPhoneNumber.trim();
  if (!normalized) return '';
  if (!normalized.startsWith('+')) return '';

  const digits = normalized.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return '';

  return `+${digits}`;
}

function normalizeOtpCode(rawCode) {
  if (typeof rawCode !== 'string' && typeof rawCode !== 'number') return '';
  const normalized = String(rawCode).trim();
  if (!/^\d{4,10}$/.test(normalized)) return '';
  return normalized;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function maskValue(raw) {
  if (!raw) return '<empty>';
  if (raw.length <= 6) return '***';
  return `${raw.slice(0, 4)}***${raw.slice(-3)}`;
}

module.exports = {
  TwilioVerifyService
};
