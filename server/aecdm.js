const { AECDM_GRAPHQL_URL, AECDM_PAGE_LIMIT } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('app:graphql');

const operationName = (query) => {
  const match = /(?:query|mutation)\s+(\w+)/.exec(query);
  return match ? match[1] : 'anonymous';
};

/**
 * Thin POST wrapper over the AEC Data Model GraphQL endpoint.
 * https://developer.api.autodesk.com/aec/graphql
 */
async function graphql(accessToken, query, variables = {}) {
  const name = operationName(query);
  const done = log.time(`→ ${name}`);
  log(`→ ${name}`, variables);

  const res = await fetch(AECDM_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await res.json().catch(() => null);

  // pointValue is the query's cost against the 300 points/minute budget.
  const cost = payload && payload.extensions ? payload.extensions.pointValue : undefined;
  done(`← ${res.status}`, cost !== undefined ? `${cost} points` : '');

  if (!res.ok) {
    const error = new Error(`AEC Data Model API returned ${res.status}`);
    error.status = res.status;
    error.details = payload;
    log.error(`${name} failed`, payload);
    throw error;
  }
  if (payload && payload.errors && payload.errors.length) {
    const error = new Error(payload.errors.map((e) => e.message).join('; '));
    error.status = 502;
    error.details = payload.errors;
    // Always print the operation and its variables: a validation error is almost always
    // about a value we sent, and the message alone does not say which query sent it.
    log.error(`${name} returned errors`, { variables, errors: payload.errors });
    throw error;
  }
  return payload.data;
}

const GET_HUBS = `
query GetHubs($pagination: PaginationInput) {
  hubs(pagination: $pagination) {
    pagination { cursor }
    results { id name }
  }
}`;

const GET_PROJECTS = `
query GetProjects($hubId: ID!, $pagination: PaginationInput) {
  projects(hubId: $hubId, pagination: $pagination) {
    pagination { cursor }
    results {
      id
      name
      alternativeIdentifiers { dataManagementAPIProjectId }
    }
  }
}`;

// parentFolder.parentFolder is the Plant 3D project folder the data set sits under,
// so the grouping needs no Data Management lookups.
const ELEMENT_GROUP_FIELDS = `
  id
  name
  parentFolder {
    id
    name
    parentFolder { id name }
  }
  alternativeIdentifiers { fileUrn fileVersionUrn }`;

const GET_ELEMENT_GROUPS_BY_PROJECT = `
query GetElementGroupsByProject($projectId: ID!, $filter: ElementGroupFilterInput, $pagination: PaginationInput) {
  elementGroupsByProject(projectId: $projectId, filter: $filter, pagination: $pagination) {
    pagination { cursor }
    results {${ELEMENT_GROUP_FIELDS}
    }
  }
}`;

const GET_FOLDERS_BY_PROJECT = `
query GetFoldersByProject($projectId: ID!) {
  foldersByProject(projectId: $projectId) {
    results {
      id
      name
      folders { results { id name } }
    }
  }
}`;

const GET_ELEMENT_GROUPS_BY_FOLDER = `
query GetElementGroupsByFolderAndSubFolders($projectId: ID!, $folderId: ID!, $filter: ElementGroupFilterInput, $pagination: PaginationInput) {
  elementGroupsByFolderAndSubFolders(
    projectId: $projectId
    folderId: $folderId
    filter: $filter
    pagination: $pagination
  ) {
    pagination { pageSize cursor }
    results {${ELEMENT_GROUP_FIELDS}
    }
  }
}`;

/**
 * Walks a cursor-paginated AEC DM query to completion.
 * `field` is the top-level response key, e.g. "hubs".
 */
async function fetchAllPages(accessToken, query, field, variables = {}, limit = AECDM_PAGE_LIMIT) {
  const all = [];
  let cursor = null;

  do {
    const data = await graphql(accessToken, query, {
      ...variables,
      pagination: { limit, cursor },
    });
    const page = data[field];
    all.push(...(page.results || []));
    cursor = page.pagination ? page.pagination.cursor : null;
  } while (cursor);

  log(`${field}: ${all.length} result(s)`);
  return all;
}

const getHubs = (accessToken) => fetchAllPages(accessToken, GET_HUBS, 'hubs');

const getProjects = (accessToken, hubId) =>
  fetchAllPages(accessToken, GET_PROJECTS, 'projects', { hubId });

/**
 * Every element in an element group WITH its full property bag.
 *
 * One query serves both charts: the overview needs only "Table Names" (the
 * class ancestry), while the quality checks need every value. Fetching the lot
 * once is half the requests of two scoped passes — but it is ~8 KB per element
 * rather than ~150 bytes, so on a very large model raise AECDM_PAGE_LIMIT
 * (max 99) to cut the round trips, or pass `filter` to narrow the set.
 */
const GET_ELEMENTS_FULL = `
query GetElementsFull($elementGroupId: ID!, $filter: ElementFilterInput, $pagination: PaginationInput) {
  elementsByElementGroup(elementGroupId: $elementGroupId, filter: $filter, pagination: $pagination) {
    pagination { cursor }
    results {
      id
      properties {
        results { name displayValue definition { id } }
      }
    }
  }
}`;

module.exports = {
  graphql,
  fetchAllPages,
  getHubs,
  getProjects,
  GET_ELEMENT_GROUPS_BY_PROJECT,
  GET_FOLDERS_BY_PROJECT,
  GET_ELEMENT_GROUPS_BY_FOLDER,
  GET_ELEMENTS_FULL,
};
