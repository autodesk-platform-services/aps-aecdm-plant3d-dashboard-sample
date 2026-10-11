-- Every relationship type declared by the project.
--
-- 19 in ProcessPower.dcf. Five are abstract (ReferenceRelationship, LineFlag,
-- SegmentBreak, PipeLineGroupSignalLineGroup, ...) and have no physical table,
-- so they carry no endpoints and hold no elements.
SELECT
    RelationshipTypeName AS TypeName,
    PhysicalName
FROM PnPRelationshipTypes
ORDER BY RelationshipTypeName;
