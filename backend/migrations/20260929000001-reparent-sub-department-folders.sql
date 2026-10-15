-- Reparent sub-department folders under their PARENT department's own
-- folder, matching departments.parent_id (which HierarchyTreeBrowser's
-- Operations "Hierarchy Browser" and /departments/tree already walk
-- correctly). getOrCreateDepartmentFolder used to always anchor every
-- department's folder to its org unit's folder regardless of
-- department.parent_id, so a sub-department's folder -- and everything
-- created under it -- landed as a SIBLING of its parent department's folder
-- in the folder_nodes parent_id chain instead of a child. The Browse page's
-- "Subfolders" panel walks folder_nodes.parent_id, so it silently dropped
-- every sub-department (e.g. Information Technology's Enterprise Resource
-- Planning / Infrastructure / Software Engineering) even though the org
-- chart-driven Hierarchy tree showed them nested correctly.
--
-- SAFE: reparents + rewrites path/level only for folders provably misrooted
-- relative to their own department's parent_id (verified against the correct
-- parent department's own canonical folder, same lookup getOrCreateDepartmentFolder
-- uses). No folder is created or deleted, no departmentId/document is changed,
-- and folder ACL ancestry is resolved by a live parent_id walk at request time
-- (resolveACL.ts), so correcting parent_id here is what actually fixes access
-- -- there is no separate materialized ACL structure to keep in sync.
-- Processes departments top-down (by department level) so a multi-level
-- chain reparents parents before children.
--
-- departments/folder_nodes both have FORCE ROW LEVEL SECURITY, and the
-- migration DB user is not exempt (not a superuser, no BYPASSRLS) -- every
-- row is invisible until app.current_tenant is set, so this loops over every
-- tenant explicitly and sets it (set_config(..., true) scopes it to this
-- transaction only) before touching that tenant's rows.

DO $$
DECLARE
  tenant_rec RECORD;
  rec RECORD;
  correct_parent_id UUID;
  correct_parent_path TEXT;
  correct_parent_level INT;
  old_path TEXT;
  old_level INT;
  new_path TEXT;
  level_delta INT;
BEGIN
  FOR tenant_rec IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', tenant_rec.id, true);

    FOR rec IN
      SELECT d.id AS dept_id, d.parent_id AS parent_dept_id,
             f.id AS folder_id, f.parent_id AS folder_parent_id,
             f.path AS folder_path, f.level AS folder_level
      FROM departments d
      JOIN LATERAL (
        SELECT id, parent_id, path, level
        FROM folder_nodes
        WHERE department_id = d.id AND is_active = true AND level > 0 AND path LIKE '/%'
        ORDER BY level ASC, created_at ASC
        LIMIT 1
      ) f ON true
      WHERE d.parent_id IS NOT NULL
      ORDER BY d.level ASC NULLS LAST
    LOOP
      SELECT pf.id, pf.path, pf.level INTO correct_parent_id, correct_parent_path, correct_parent_level
      FROM folder_nodes pf
      WHERE pf.department_id = rec.parent_dept_id AND pf.is_active = true AND pf.level > 0 AND pf.path LIKE '/%'
      ORDER BY pf.level ASC, pf.created_at ASC
      LIMIT 1;

      -- Parent department has no folder provisioned yet -- nothing to anchor
      -- to. It will be provisioned correctly (already-nested) on first use by
      -- the fixed getOrCreateDepartmentFolder, so this dept is skipped.
      IF correct_parent_id IS NULL THEN
        CONTINUE;
      END IF;

      -- Already correctly anchored.
      IF rec.folder_parent_id IS NOT DISTINCT FROM correct_parent_id THEN
        CONTINUE;
      END IF;

      old_path := rec.folder_path;
      old_level := rec.folder_level;
      new_path := correct_parent_path || '/' || regexp_replace(old_path, '^.*/', '');
      level_delta := (correct_parent_level + 1) - old_level;

      UPDATE folder_nodes
      SET parent_id = correct_parent_id, level = correct_parent_level + 1, path = new_path
      WHERE id = rec.folder_id;

      -- Cascade the path-prefix rename + level shift to every existing
      -- descendant (category folders, and anything nested under them) --
      -- their own parent_id values are unaffected, only the ancestor path
      -- prefix and absolute level shift.
      UPDATE folder_nodes
      SET path = new_path || substring(path FROM char_length(old_path) + 1),
          level = level + level_delta
      WHERE path LIKE old_path || '/%';
    END LOOP;
  END LOOP;
END $$;
