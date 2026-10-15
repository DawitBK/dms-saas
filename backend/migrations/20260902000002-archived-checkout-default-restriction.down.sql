DELETE FROM document_status_action_roles
WHERE status = 'ARCHIVED' AND action = 'checkout' AND role_name = 'SYSTEM_ADMIN';
