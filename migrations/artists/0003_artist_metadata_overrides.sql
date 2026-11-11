-- Field-level intent is independent of row source. Preserve every existing
-- nonempty curated field from both admin saves and manifest imports.
-- Migration policy for the verified version-1 cutover dataset: blank fields
-- were unspecified, not known intentional clears, so they allow automatic fill.
-- Future explicit clears store an empty value with override = 1; only an
-- explicit "Use Automatic" save unlocks that field. Raw values, versions,
-- timestamps, ownership and aliases are left untouched by this migration.
ALTER TABLE artist_profiles ADD COLUMN img_override INTEGER NOT NULL DEFAULT 0
  CHECK (img_override IN (0, 1));
ALTER TABLE artist_profiles ADD COLUMN bio_override INTEGER NOT NULL DEFAULT 0
  CHECK (bio_override IN (0, 1));

UPDATE artist_profiles SET
  img_override = CASE WHEN trim(img) <> '' THEN 1 ELSE 0 END,
  bio_override = CASE WHEN trim(bio) <> '' THEN 1 ELSE 0 END;

-- Publish the new public fields once. Automatic lookup/cache updates never
-- change this directory revision or any artist profile version.
UPDATE artist_catalog_state SET revision = revision + 1 WHERE id = 1;
