-- Allowed values per picklist, for validating PnPPickListType columns.
SELECT
    l.PicklistName,
    v.PicklistValue
FROM PnPPicklists l
JOIN PnPPicklistValues v ON v.PicklistId = l.PnPID
WHERE v.PicklistValue IS NOT NULL AND TRIM(v.PicklistValue) <> '';
