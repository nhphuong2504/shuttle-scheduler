# Scheduling core

Read `docs/tournament-format.md` and `docs/scheduling-decisions.md`, then the linked
detail sections for the rule being changed. The core stays independent of tournament
tables, Supabase, UI and sport-specific rules; adapters live in tournament/scheduling.
Preserve seeded determinism, individual-player constraints, fixed history and independent
validation. Keep every fixture/seed/run combination when restructuring tests.

Benchmarks/replay remain separate from the normal regression gate. Scheduling edits take
the full high-risk gate; SQL guards and RPC callers also require local integration.
The landing's reflow and rest claims must continue to match the live product's actual policy.
