require('dotenv').config();

const {
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  APS_CALLBACK_URL,
  SERVER_SESSION_SECRET,
  PORT = 8080,
  ENABLE_DEBUG_ENDPOINTS,
} = process.env;

const missing = Object.entries({
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  APS_CALLBACK_URL,
  SERVER_SESSION_SECRET,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

module.exports = {
  APS_CLIENT_ID,
  APS_CLIENT_SECRET,
  APS_CALLBACK_URL,
  SERVER_SESSION_SECRET,
  PORT,

  // Mounts /api/debug/*, which exposes the session's access token. Local use only.
  ENABLE_DEBUG_ENDPOINTS: ENABLE_DEBUG_ENDPOINTS === 'true',

  // 3-legged scopes. AEC Data Model needs data:read; user:read backs the /userinfo call.
  SCOPES: ['data:read', 'data:create', 'data:write', 'viewables:read', 'user:read'],

  AECDM_GRAPHQL_URL: 'https://developer.api.autodesk.com/aec/graphql',
  DM_BASE_URL: 'https://developer.api.autodesk.com/data/v1',

  // ElementGroup names that identify a Plant 3D data set.
  PLANT3D_DATASET_NAMES: ['P&ID Data Set', '3D Piping Data Set', '3D Models Data Set'],

  // How the Plant 3D scan finds element groups:
  //   "project" — one elementGroupsByProject cursor walk over the whole project.
  //               Simple, but on a large project it is slow enough to time out.
  //   "folder"  — list the project's folders, then run elementGroupsByFolderAndSubFolders
  //               per Plant 3D project folder, several at a time.
  EXTRACT_GROUPS_WAY: extractGroupsWay(),

  // How many folder subtrees to scan at once in "folder" mode.
  FOLDER_SCAN_CONCURRENCY: 4,

  // Page size for every paginated AEC DM query.
  //
  // PaginationInput.limit is validated as "between 0 and 100" EXCLUSIVE — sending 100
  // is rejected outright. A smaller page also keeps the query under the 1000-point cap,
  // which a wide selection set can otherwise blow through.
  AECDM_PAGE_LIMIT: pageLimit(),
};

function extractGroupsWay() {
  // Accept the .env spelling from the skill doc as well as the SHOUTY one.
  const raw = (process.env.ExtractGroupsWay || process.env.EXTRACT_GROUPS_WAY || 'folder')
    .trim()
    .toLowerCase();
  if (raw !== 'project' && raw !== 'folder') {
    console.error(`ExtractGroupsWay must be "project" or "folder" (got "${raw}")`);
    process.exit(1);
  }
  return raw;
}

function pageLimit() {
  const configured = Number(process.env.AECDM_PAGE_LIMIT || 50);
  if (!Number.isInteger(configured) || configured < 1 || configured > 99) {
    console.error(`AECDM_PAGE_LIMIT must be an integer from 1 to 99 (got ${configured})`);
    process.exit(1);
  }
  return configured;
}
