const path = require('path');
const express = require('express');
const session = require('express-session');

const {
  PORT,
  SERVER_SESSION_SECRET,
  ENABLE_DEBUG_ENDPOINTS,
  EXTRACT_GROUPS_WAY,
} = require('./config');
const { createLogger, anyEnabled } = require('./logger');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const log = createLogger('app:http');
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  session({
    secret: SERVER_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// Request log — only active when DEBUG includes "http".
app.use((req, res, next) => {
  if (!log.enabled) return next();
  const done = log.time(`${req.method} ${req.originalUrl}`);
  res.on('finish', () => done(`← ${res.statusCode}`));
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);

if (ENABLE_DEBUG_ENDPOINTS) {
  app.use('/api/debug', require('./routes/debug'));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  else log.error(`${status} ${req.originalUrl}: ${err.message}`, err.details);

  res.status(status).json({
    error: err.message,
    details: err.details,
    // Stacks only leak to the client while debugging.
    stack: anyEnabled ? err.stack : undefined,
  });
});

// Surface async faults that would otherwise kill the process silently.
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`Plant 3D scan: ExtractGroupsWay=${EXTRACT_GROUPS_WAY}`);
  if (anyEnabled) console.log(`Debug logging: DEBUG=${process.env.DEBUG}`);
  if (ENABLE_DEBUG_ENDPOINTS) console.log('Debug endpoints mounted at /api/debug (local only)');
});
