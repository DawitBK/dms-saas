-- Add parent_id, path, level to departments table for nested hierarchy
CREATE EXTENSION IF NOT EXISTS ltree;

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS path LTREE,
  ADD COLUMN IF NOT EXISTS level INTEGER;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS departments_parent_id_idx ON departments (parent_id);
CREATE INDEX IF NOT EXISTS departments_path_gist_idx ON departments USING GIST (path);

-- Function to update path and level for a department and its descendants
CREATE OR REPLACE FUNCTION department_ltree_label(p_dept_id UUID)
RETURNS TEXT AS $$
BEGIN
  RETURN 'd_' || replace(p_dept_id::TEXT, '-', '_');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION update_department_path(p_dept_id UUID)
RETURNS VOID AS $$
DECLARE
  v_parent_path LTREE;
  v_new_path LTREE;
BEGIN
  -- Get parent's path (if exists)
  SELECT path INTO v_parent_path
  FROM departments
  WHERE id = (SELECT parent_id FROM departments WHERE id = p_dept_id);

  -- Construct new path
  IF v_parent_path IS NOT NULL THEN
    v_new_path := v_parent_path || text2ltree(department_ltree_label(p_dept_id));
  ELSE
    v_new_path := text2ltree(department_ltree_label(p_dept_id));
  END IF;

  -- Update this department
  UPDATE departments
  SET path = v_new_path,
      level = GREATEST(nlevel(v_new_path) - 1, 0)
  WHERE id = p_dept_id;

  -- Recursively update all descendants
  PERFORM update_department_path(id)
  FROM departments
  WHERE parent_id = p_dept_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION departments_before_insert_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := text2ltree(department_ltree_label(NEW.id));
    NEW.level := 0;
  ELSE
    SELECT path || text2ltree(department_ltree_label(NEW.id)), GREATEST(nlevel(path || text2ltree(department_ltree_label(NEW.id))) - 1, 0)
      INTO NEW.path, NEW.level
    FROM departments
    WHERE id = NEW.parent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update path/level when parent_id changes
CREATE OR REPLACE FUNCTION departments_parent_id_change_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.parent_id IS DISTINCT FROM NEW.parent_id) THEN
    PERFORM update_department_path(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_departments_before_insert ON departments;
CREATE TRIGGER trigger_departments_before_insert
BEFORE INSERT ON departments
FOR EACH ROW
EXECUTE FUNCTION departments_before_insert_trigger();

DROP TRIGGER IF EXISTS trigger_departments_parent_id_change ON departments;
CREATE TRIGGER trigger_departments_parent_id_change
AFTER UPDATE OF parent_id ON departments
FOR EACH ROW
EXECUTE FUNCTION departments_parent_id_change_trigger();

-- Backfill existing departments, including descendants
DO $$
DECLARE
  dept_record RECORD;
BEGIN
  FOR dept_record IN
    SELECT id
    FROM departments
    ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, created_at, id
  LOOP
    PERFORM update_department_path(dept_record.id);
  END LOOP;
END $$;
