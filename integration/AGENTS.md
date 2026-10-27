# Backend integration

Read `docs/verification.md#local-integration` and the current authorization contract.
The suite writes data and must use the local stack, never staging/production. Keep the
setup guard, root-project exclusion and suite/app target parity. No skip is success.

Use service-role credentials only to create/clean fixtures. Assert permissions and writes
through the actual caller's client. Keep files sequential; warm cold Realtime. Restore
the exact original environment after manual changes and stop only services you started.
Never dump keys, supabase status output, environment files or recorded sessions into logs.

The existing CI workflow provides local-stack evidence without workstation Docker.
Missing local prerequisites stay explicit. RPC/RLS/realtime changes require real
integration in addition to the full gate.
