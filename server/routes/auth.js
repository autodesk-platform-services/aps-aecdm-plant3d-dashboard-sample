const express = require('express');
const { getAuthorizationUrl, completeLogin, isLoggedIn } = require('../auth');

const router = express.Router();

router.get('/login', (req, res) => {
  res.redirect(getAuthorizationUrl());
});

router.get('/callback', async (req, res, next) => {
  if (req.query.error) {
    return next(new Error(`${req.query.error}: ${req.query.error_description || ''}`));
  }
  try {
    await completeLogin(req, req.query.code);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/profile', (req, res) => {
  if (!isLoggedIn(req) || !req.session.profile) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  res.json(req.session.profile);
});

module.exports = router;
