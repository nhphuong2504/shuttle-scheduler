# Migrations

Read README.md here before adding/applying a migration and the relevant history.md entry.
Applied SQL is immutable and runs in filename order. Add new migrations; do not rewrite
or squash deployment history to reduce size.

Before changing grants/guards read the current authorization contract and exact predicate
and lifecycle details. Preserve explicit EXECUTE grants/revokes, SECURITY DEFINER search
paths, row/column privileges and transactional locking. Browser affordances grant nothing.

Database/RPC changes require the full gate and local integration for RLS, guards or realtime
membership. Fresh replay and existing-data behavior are different checks. Never validate
a migration by applying it to a hosted project as an automated test.
