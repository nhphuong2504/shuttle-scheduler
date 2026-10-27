# Tournament domain

Read `docs/tournament-format.md`. Before modifying scheduling, access, registration or
roster transitions, read the current contract and exact detail sections from agent:context.
Pure rules remain testable without React/Supabase. Keep participant requests, operator
reviews, window operations and stable query keys in their owning registration modules.

Approval grants participation, never authority. Authorization and lifecycle remain separate
database questions. Preserve atomic writes, refusals, scoping, cache invalidation and the
distinction between supported placement and legacy round-robin. Superficially similar
bracket builders can have different rematch rules; check the format before unifying them.

Scoring/scheduling/auth/RPC edits take the full gate. RPC/auth/realtime changes also need
real local integration. Keep secret/import guards; replace SQL-text behavior assertions
only after equivalent local integration behavior has been demonstrated.
