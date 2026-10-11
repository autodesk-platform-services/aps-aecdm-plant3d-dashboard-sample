const { AuthenticationClient, ResponseType } = require('@aps_sdk/authentication');
const {
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  APS_CALLBACK_URL,
  SCOPES,
} = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('app:auth');

const authenticationClient = new AuthenticationClient();

// Refresh a little before the token actually dies so an in-flight call cannot expire mid-request.
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Authorization-code URL the browser is redirected to for the 3-legged login.
 */
function getAuthorizationUrl() {
  // scopes is a positional argument, not part of the optional-args object.
  const url = authenticationClient.authorize(
    APS_CLIENT_ID,
    ResponseType.Code,
    APS_CALLBACK_URL,
    SCOPES,
  );
  log('authorize url', url);
  return url;
}

/**
 * Exchanges the ?code= from the callback for a token pair and stores it on the session.
 */
async function completeLogin(req, code) {
  const credentials = await authenticationClient.getThreeLeggedToken(
    APS_CLIENT_ID,
    code,
    APS_CALLBACK_URL,
    { clientSecret: APS_CLIENT_SECRET },
  );
  storeCredentials(req, credentials);
  req.session.profile = await fetchProfile(credentials.access_token);
  log('signed in', req.session.profile);
  return req.session.profile;
}

function storeCredentials(req, credentials) {
  req.session.accessToken = credentials.access_token;
  req.session.refreshToken = credentials.refresh_token;
  req.session.expiresAt = Date.now() + credentials.expires_in * 1000;
  log(`token stored, expires in ${credentials.expires_in}s`);
}

async function fetchProfile(accessToken) {
  const info = await authenticationClient.getUserInfo(accessToken);
  return {
    id: info.sub,
    name: info.name || [info.given_name, info.family_name].filter(Boolean).join(' '),
    email: info.email,
    picture: info.picture,
  };
}

function isLoggedIn(req) {
  return Boolean(req.session && req.session.refreshToken);
}

/**
 * Returns a valid access token for the session, refreshing it when it is close to expiry.
 * Throws when there is no session to refresh from.
 */
async function getAccessToken(req) {
  if (!isLoggedIn(req)) {
    const error = new Error('Not signed in');
    error.status = 401;
    throw error;
  }
  if (req.session.accessToken && Date.now() < req.session.expiresAt - EXPIRY_MARGIN_MS) {
    return req.session.accessToken;
  }
  log('access token expired, refreshing');
  // refreshToken(refreshToken, clientId, optionalArgs) — the token comes first.
  const credentials = await authenticationClient.refreshToken(
    req.session.refreshToken,
    APS_CLIENT_ID,
    { clientSecret: APS_CLIENT_SECRET, scopes: SCOPES },
  );
  storeCredentials(req, credentials);
  return req.session.accessToken;
}

/**
 * Express middleware: 401s anonymous callers, otherwise puts a fresh token on req.accessToken.
 */
async function requireAuth(req, res, next) {
  try {
    req.accessToken = await getAccessToken(req);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAuthorizationUrl,
  completeLogin,
  isLoggedIn,
  getAccessToken,
  requireAuth,
};
