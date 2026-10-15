-- Reverts to one role per group. Only safe if no group/override currently
-- carries more than one role_name row -- run the check below before this,
-- and resolve any multi-role group manually (decide which single role wins)
-- if it returns any rows.
--   SELECT relying_party, ad_group_dn, count(*) FROM idp_role_mappings
--   GROUP BY relying_party, ad_group_dn HAVING count(*) > 1;
ALTER TABLE idp_role_mappings DROP CONSTRAINT idp_role_mappings_relying_party_ad_group_dn_role_name_key;
ALTER TABLE idp_role_mappings ADD CONSTRAINT idp_role_mappings_relying_party_ad_group_dn_key
  UNIQUE (relying_party, ad_group_dn);
