-- Cascades to user_roles (roles.id is referenced ON DELETE CASCADE), so any
-- account holding PLATFORM_ADMIN loses it along with the role row itself.
DELETE FROM roles WHERE name = 'PLATFORM_ADMIN';
