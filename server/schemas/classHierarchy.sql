-- Class hierarchy of the P&ID tables defined in ProcessPower.dcf.
--
-- PnPTables holds one row per class, linked to its parent through BaseTable.
-- The single root is PnPBase (BaseTable = ''). Display names live in
-- PnPTableAttributes under AttributeName = 'DisplayName'.
--
-- Ordering by Path yields a depth-first walk with siblings in alphabetical
-- order, so consumers can build a tree by appending rows in order.

WITH RECURSIVE ClassHierarchy AS
(
    -- Root
    SELECT
        t.TableName,
        t.BaseTable,
        t.Abstract,
        a.AttributeValue AS DisplayName,
        0 AS Level,
        t.TableName AS Path
    FROM PnPTables t
    LEFT JOIN PnPTableAttributes a
        ON a.TableName = t.TableName
       AND a.AttributeName = 'DisplayName'
    WHERE t.BaseTable = ''

    UNION ALL

    -- Children
    SELECT
        child.TableName,
        child.BaseTable,
        child.Abstract,
        a.AttributeValue AS DisplayName,
        parent.Level + 1 AS Level,
        parent.Path || ' > ' || child.TableName AS Path
    FROM PnPTables child
    JOIN ClassHierarchy parent
        ON child.BaseTable = parent.TableName
    LEFT JOIN PnPTableAttributes a
        ON a.TableName = child.TableName
       AND a.AttributeName = 'DisplayName'
)
SELECT
    Level,
    printf('%*s%s', Level * 2, '', TableName) AS Hierarchy,
    TableName,
    DisplayName,
    BaseTable AS ParentClass,
    Abstract
FROM ClassHierarchy
ORDER BY Path;
