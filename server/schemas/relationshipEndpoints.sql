-- The endpoint columns of each relationship table — the roles that hold the
-- PnPID of a related element.
--
--   LineOffPageConnector -> Line, OffPageConnector
--   AssetOwnership       -> Owner, Owned
--
-- Excluded: the system columns, and anything listed in PnPRelationshipProperties
-- (those are attributes of the relationship, e.g. LineStartLine.ParamOnLine,
-- not a pointer to another element).
--
-- NOTE these role names are NOT class names. `LineOffPageConnector.Line` points
-- at a Lines element whose own class is e.g. `Primary`. Matching pairs by class
-- name therefore does not work; match on PnPID, which is unique project-wide.
SELECT
    t.RelationshipTypeName AS TypeName,
    ti.name                AS Role,
    ti.type                AS ColumnType
FROM PnPRelationshipTypes t
JOIN pragma_table_info(t.PhysicalName) ti
WHERE ti.name NOT IN ('PnPID', 'PnPGuid', 'PnPTimestamp')
  AND NOT EXISTS (
        SELECT 1 FROM PnPRelationshipProperties p
        WHERE p.RelationshipTypeName = t.RelationshipTypeName
          AND p.PropertyName = ti.name
      )
ORDER BY t.RelationshipTypeName, ti.cid;
