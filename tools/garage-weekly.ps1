# Weekly refresh of the ready-made garage from the newest save backup in Downloads.
#
# Runs tools/garage-refresh.mjs on the newest nfsu2-saves-*.zip, and when the garage changed, runs the garage test
# and commits src/garage-data.js and docs/garage-defaults.md on main. The repo's post-commit hook then copies the
# commit to the unpacked install folder, so the installed extension shows the new cars after Chrome reloads it.
# A store install changes only with a new store version: this script never builds, uploads or publishes anything.
#
# It refuses (exit 1, nothing committed) when the checkout is not on main, has other changes, or a step fails.
# Exit 0 with "unchanged" when the newest backup gives the same garage.
#
# Run by hand:  & "<repo>\tools\garage-weekly.ps1" -Bun "<GLOBALB.BUN>"
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Downloads = (Join-Path $env:USERPROFILE 'Downloads'),
  [Parameter(Mandatory = $true)][string]$Bun,
  [string]$Log = (Join-Path $env:LOCALAPPDATA 'nfsu2-garage-weekly.log')
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

function Say([string]$text) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
  Add-Content -Path $Log -Value $line -Encoding utf8
  Write-Output $line
}

Push-Location $Repo
try {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne 'main') { throw "the checkout is on $branch, not main" }
  $dirty = git status --porcelain
  if ($dirty) { throw 'the checkout has uncommitted changes' }
  if (-not (Test-Path $Bun)) { throw "no game data file at the -Bun path" }

  $out = node tools/garage-refresh.mjs --bun $Bun --from $Downloads 2>&1 | Out-String
  Say $out.Trim()
  if ($out -match '^unchanged') { exit 0 }

  $test = node test/garage.test.mjs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "the garage test failed: $test" }

  $saved = if ($out -match 'career saved (\d{4}-\d{2}-\d{2})') { $Matches[1] } else { 'unknown date' }
  $msg = Join-Path $env:TEMP 'nfsu2-garage-weekly-msg.txt'
  Set-Content -Path $msg -Encoding utf8 -Value @(
    "chore(garage): refresh the ready-made garage from the save of $saved",
    '',
    'Weekly run of tools/garage-weekly.ps1. tools/garage-refresh.mjs passed its allowlist and profile-name checks',
    'before writing, and test/garage.test.mjs passed after.'
  )
  git add -- src/garage-data.js docs/garage-defaults.md
  git commit -F $msg
  Remove-Item $msg
  Say "committed $(git rev-parse --short HEAD)"
} catch {
  Say "refused: $($_.Exception.Message)"
  exit 1
} finally {
  Pop-Location
}
