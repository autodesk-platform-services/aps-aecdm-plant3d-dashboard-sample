/**
 * Local troubleshooting endpoints. Mounted only when ENABLE_DEBUG_ENDPOINTS=true,
 * because /token hands out the signed-in user's access token. Never enable in production.
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { graphql } = require('../aecdm');
const { dmGet } = require('../dm');
const { SCOPES, PLANT3D_DATASET_NAMES } = require('../config');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));
router.use(requireAuth);

/** What the server thinks the session is. */
router.get('/session', (req, res) => {
  res.json({
    profile: req.session.profile,
    scopes: SCOPES,
    expiresAt: new Date(req.session.expiresAt).toISOString(),
    expiresInSeconds: Math.round((req.session.expiresAt - Date.now()) / 1000),
    datasetNames: PLANT3D_DATASET_NAMES,
  });
});

/** Bearer token for poking the APS APIs from curl, Postman, or GraphiQL. */
router.get('/token', (req, res) => {
  res.json({ access_token: req.accessToken, expires_at: req.session.expiresAt });
});

/** Scratchpad: POST { query, variables } straight through to AEC Data Model. */
router.post('/graphql', async (req, res, next) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Body must include a "query" string' });
    res.json(await graphql(req.accessToken, query, variables || {}));
  } catch (err) {
    next(err);
  }
});

/** Scratchpad: proxy a Data Management GET, e.g. /api/debug/dm?path=/projects/b.xxx/folders/urn */
router.get('/dm', async (req, res, next) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'Pass ?path=/projects/…' });
    res.json(await dmGet(req.accessToken, req.query.path));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
