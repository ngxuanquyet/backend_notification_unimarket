require('dotenv').config();

function getEnv() {
  return {
    nodeEnv: process.env.NODE_ENV || '',
    port: Number(process.env.PORT || 8080),
    hasFirebaseProjectId: Boolean(process.env.FIREBASE_PROJECT_ID),
    hasFirebaseServiceAccountJson: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    hasTwilioAccountSid: Boolean(process.env.TWILIO_ACCOUNT_SID),
    hasTwilioAuthToken: Boolean(process.env.TWILIO_AUTH_TOKEN),
    hasTwilioVerifyServiceSid: Boolean(process.env.TWILIO_VERIFY_SERVICE_SID)
  };
}

module.exports = {
  getEnv
};
