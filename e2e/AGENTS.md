# Browser tests

Read `docs/verification.md#browser-checks`. Import test from the shared app fixture.
Never use a hosted Supabase fallback or real recorded session for automated tests.
Keep mock escape detection, pinned clocks and independent page state.

Retain accessibility checks, zero skips, current workers/shards and cold-route preparation.
Test browser-only facts here; pure/component behavior belongs in cheaper tests, and real
RLS/RPC/realtime behavior in integration. jsdom cannot replace layout measurements.
Split unrelated navigation budgets without dropping assertions.

Use test:e2e:final with a spec for investigation, then the full gate at phase close.
Refresh ci:shard-plan after collection changes. When listing tests override the reporter
so the listing cannot overwrite the complete report used for planning.
