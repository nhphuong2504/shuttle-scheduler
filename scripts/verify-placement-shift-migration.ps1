# Proves the change to `shift_live_schedule_after_match` is additive.
#
# Splicing text into a copy of a working function is only safe if nothing in the
# original was lost, reordered, or altered. Comparing line counts would not show
# that. This walks the ORIGINAL function's lines and requires each one to appear
# in the generated function, in order, as a subsequence. Any dropped line, any
# reordering, or any edit to an existing line fails the check.
#
# The two original lines that a splice deliberately rewrites are listed explicitly
# and matched against their intended replacement instead.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$origPath = Join-Path $root 'supabase/migrations/20260915000000_tournament_scoping.sql'
$newPath = Join-Path $root 'supabase/migrations/20260917030000_placement_live_schedule_shift.sql'

$create = 'CREATE OR REPLACE FUNCTION public.shift_live_schedule_after_match('
$endMarker = "`r`n`$`$;"

function Get-FunctionBody {
  param([string]$Text, [string]$Label)
  $start = $Text.IndexOf($create)
  if ($start -lt 0) { throw "CREATE not found in $Label" }
  $end = $Text.IndexOf($endMarker, $start)
  if ($end -lt 0) { throw "terminator not found in $Label" }
  return $Text.Substring($start, $end - $start)
}

$origText = [System.IO.File]::ReadAllText($origPath)
$newText = [System.IO.File]::ReadAllText($newPath)

$origFn = Get-FunctionBody $origText 'the original migration'
$newFn = Get-FunctionBody $newText 'the generated migration'

# The generated file contains TWO functions ending in `$$;` (the shift and the two
# report RPCs come after it), so re-read with an explicit end to be certain the
# first one is the shift function and not a later body.
if ($newFn -notmatch 'live_schedule_work') { throw 'generated body is not the shift function' }

# Lines a splice intentionally rewrites: original text -> required replacement.
# All three are one-line-for-one-line swaps, so the ordering check below stays
# aligned and cannot silently skip past a deleted line.
$rewrites = @{
  "  IF p_table NOT IN ('pool_matches', 'draw_matches') THEN" =
    "  IF p_table NOT IN ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches') THEN"
  '  ELSE' = "  ELSIF p_table = 'draw_matches' THEN"
  '    AND COALESCE(dm.is_bye, false) = false;' = '    AND COALESCE(dm.is_bye, false) = false'
}

# `  ELSE` with exactly two spaces must be unique to the source-row lookup. The
# CASE expressions deeper in the function are indented further, and if that ever
# stopped being true this rewrite would corrupt them -- so it is asserted, not
# assumed.
$elseCount = ($origFn -split "`r`n" | Where-Object { $_ -ceq '  ELSE' }).Count
if ($elseCount -ne 1) { throw "expected exactly one two-space ELSE in the function, found $elseCount" }

$origLines = $origFn -split "`r`n"
$newLines = $newFn -split "`r`n"

$cursor = 0
$rewritten = 0
# Every place the matcher had to step over generated lines. Each one must be an
# inserted block; an unexpected skip is how a lost line would hide.
$skips = @()
for ($i = 0; $i -lt $origLines.Length; $i++) {
  $line = $origLines[$i]
  $expected = $line
  if ($rewrites.ContainsKey($line)) { $expected = $rewrites[$line]; $rewritten++ }

  $found = -1
  for ($j = $cursor; $j -lt $newLines.Length; $j++) {
    if ($newLines[$j] -ceq $expected) { $found = $j; break }
  }
  if ($found -lt 0) {
    throw "original function line $($i + 1) is missing or altered in the output: [$expected]"
  }
  if ($found -gt $cursor) { $skips += [pscustomobject]@{ AtOriginalLine = $i + 1; Skipped = $found - $cursor } }
  $cursor = $found + 1
}

Write-Host "original function lines matched in order: $($origLines.Length)"
Write-Host "lines intentionally rewritten: $rewritten"
Write-Host "lines in the generated function: $($newLines.Length) (net +$($newLines.Length - $origLines.Length))"
Write-Host "insertion points (original line -> lines inserted there):"
$skips | ForEach-Object { Write-Host "  after original line $($_.AtOriginalLine): +$($_.Skipped) lines" }

# The new tables must actually be wired in, or the additivity check passes for a
# function that does nothing new. These are all inside the shift function.
$requiredInFunction = @(
  "  IF p_table NOT IN ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches') THEN",
  "  ELSIF p_table = 'placement_matches' THEN",
  '    FROM public.placement_matches',
  "    'placement_matches',",
  "    'tier_draw_matches',",
  "  SELECT 'placement_matches', pmet.id, player.player_id",
  "  SELECT 'tier_draw_matches', tdm.id, player.player_id",
  '  JOIN public.placement_entrants entrant',
  '  UPDATE public.placement_matches pmet',
  '  UPDATE public.tier_draw_matches tdm',
  '    AND NOT tdm.is_bye;'
)
$haystackFn = $newFn.Replace("`r`n", "`n")
foreach ($needle in $requiredInFunction) {
  if (-not $haystackFn.Contains($needle.Replace("`r`n", "`n"))) {
    throw "the generated function is missing a required addition: [$needle]"
  }
}

# And these are the calls that stop the first half of the change being dead code.
# They live in the two report RPCs, which follow the function, so they are checked
# against the whole file rather than the function body.
$requiredInFile = @(
  "  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);",
  "  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);",
  'CREATE OR REPLACE FUNCTION public.report_placement_result(',
  'CREATE OR REPLACE FUNCTION public.report_tier_draw_result(',
  '  PERFORM public.advance_tier_draw_locked(v_draw);'
)
$haystackFile = $newText.Replace("`r`n", "`n")
foreach ($needle in $requiredInFile) {
  if (-not $haystackFile.Contains($needle.Replace("`r`n", "`n"))) {
    throw "the generated migration is missing a required addition: [$needle]"
  }
}

# The knockout case must advance the bracket BEFORE reflowing, so a match the
# advance just created is included in the reorder. Assert the order, not just the
# presence: swapping these two lines still passes a contains-check.
$advanceAt = $haystackFile.IndexOf('PERFORM public.advance_tier_draw_locked(v_draw);')
$shiftAt = $haystackFile.IndexOf("PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);")
if ($advanceAt -lt 0 -or $shiftAt -lt 0 -or $advanceAt -gt $shiftAt) {
  throw 'the knockout report must advance the bracket before reflowing the day'
}

Write-Host "required additions present: $($requiredInFunction.Count + $requiredInFile.Count)/$($requiredInFunction.Count + $requiredInFile.Count)"
Write-Host 'verification: PASS'
