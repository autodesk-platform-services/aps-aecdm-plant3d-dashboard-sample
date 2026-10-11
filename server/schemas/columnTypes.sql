-- Declared type of every column, plus its picklist name when it has one.
--
-- PnPColumnAttributes is a long table of (TableName, ColumnName, AttributeName,
-- AttributeValue). TYPE gives the data type; PICKLISTNAME names the allowed-value
-- list for PnPPickListType columns. Types seen in ProcessPower.dcf:
--   PnPStringType (1009) · PnPPickListType (192) · PnPNumberUnitType (58)
--   PnPFlagType (3) · PnPIntType (1)
--
-- Columns are inherited, so a Primary element's Size type is declared on
-- PipeLines. Callers resolve by walking the class ancestry.
SELECT
    t.TableName,
    t.ColumnName,
    t.AttributeValue  AS Type,
    p.AttributeValue  AS PicklistName
FROM PnPColumnAttributes t
LEFT JOIN PnPColumnAttributes p
       ON p.TableName  = t.TableName
      AND p.ColumnName = t.ColumnName
      AND p.AttributeName = 'PICKLISTNAME'
WHERE t.AttributeName = 'TYPE';
