/**
 * Namespaced debug logging, controlled by the DEBUG env var. No dependency.
 *
 *   DEBUG=app:*                      everything this app logs
 *   DEBUG=app:graphql,app:dm         just those two
 *   DEBUG=*                          the above plus express/send internals, which
 *                                    also read DEBUG — very noisy
 *
 * Namespaces: app:http, app:auth, app:graphql, app:dm, app:plant3d.
 */

const patterns = (process.env.DEBUG || '')
  .split(/[\s,]+/)
  .map((p) => p.trim())
  .filter(Boolean);

const COLORS = ['36', '35', '33', '32', '34', '31'];
let nextColor = 0;

function matches(namespace) {
  return patterns.some((pattern) => {
    if (pattern === '*' || pattern === namespace) return true;
    return pattern.endsWith('*') && namespace.startsWith(pattern.slice(0, -1));
  });
}

/** Never let a bearer token reach the log. */
function redact(value) {
  if (typeof value === 'string') {
    return value.replace(/(Bearer\s+)[\w.\-]+/gi, '$1<redacted>');
  }
  return value;
}

function format(value) {
  if (typeof value === 'string') return redact(value);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function createLogger(namespace) {
  const color = COLORS[nextColor++ % COLORS.length];
  const enabled = matches(namespace);
  const tag = `\x1b[${color}m${namespace}\x1b[0m`;

  const log = (...args) => {
    if (!enabled) return;
    console.log(tag, args.map(format).join(' '));
  };

  /** Start a timer; call the returned function to log the elapsed ms. */
  log.time = (label) => {
    if (!enabled) return () => {};
    const started = process.hrtime.bigint();
    return (...args) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(tag, `${label} \x1b[2m${ms.toFixed(0)}ms\x1b[0m`, args.map(format).join(' '));
    };
  };

  /** Errors are always printed, whether or not the namespace is enabled. */
  log.error = (...args) => {
    console.error(`\x1b[31m${namespace}\x1b[0m`, args.map(format).join(' '));
  };

  log.enabled = enabled;
  return log;
}

const anyEnabled = patterns.length > 0;

module.exports = { createLogger, anyEnabled };
