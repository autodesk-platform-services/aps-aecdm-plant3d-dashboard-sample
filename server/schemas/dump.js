#!/usr/bin/env node
/**
 * Dumps the ProcessPower.dcf class hierarchy.
 *
 *   node server/schemas/dump.js <ProcessPower.dcf> [out.json]
 *   node server/schemas/dump.js <ProcessPower.dcf> --tree     # indented preview
 *
 * With no output path the JSON goes to stdout, so it pipes into jq.
 */
require('dotenv').config();

const fs = require('fs');
const { getClassHierarchy, summarize } = require('./index');
const { query } = require('./sqliteDriver');

const args = process.argv.slice(2);
const asTree = args.includes('--tree');
const [dcfPath, outPath] = args.filter((a) => !a.startsWith('--'));

function printTree(nodes, depth = 0) {
  for (const node of nodes) {
    const label = node.displayName ? `${node.tableName} — ${node.displayName}` : node.tableName;
    console.log(`${'  '.repeat(depth)}${label}${node.abstract ? '  (abstract)' : ''}`);
    printTree(node.children, depth + 1);
  }
}

try {
  const tree = getClassHierarchy(dcfPath);
  const stats = summarize(tree);

  if (asTree) {
    printTree(tree);
    console.error(`\n${JSON.stringify(stats)}  via ${query.lastDriver}`);
  } else if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(tree, null, 2));
    console.error(`Wrote ${outPath} — ${JSON.stringify(stats)}  via ${query.lastDriver}`);
  } else {
    console.log(JSON.stringify(tree, null, 2));
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
