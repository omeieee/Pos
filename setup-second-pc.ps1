# Sets up the Saap Don Sen POS dev environment at C:\ome\Pos on Windows.
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File .\setup-second-pc.ps1
$ErrorActionPreference = 'Stop'
$Root = 'C:\ome'
$Repo = "$Root\Pos"

function Need($cmd, $wingetId) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "Installing $cmd ..."
    winget install --id $wingetId -e --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  }
}

Need git 'Git.Git'
Need node 'OpenJS.NodeJS'   # must be >= 24 (see package.json engines)
Need gh   'GitHub.cli'

$major = [int]((node -v) -replace '^v(\d+).*','$1')
if ($major -lt 24) { throw "Node $(node -v) is too old; install Node 24+ (winget install OpenJS.NodeJS) and re-run." }

corepack enable
New-Item -ItemType Directory -Force $Root | Out-Null

if (-not (Test-Path "$Repo\.git")) {
  git clone https://github.com/omeieee/Pos.git $Repo
} else {
  git -C $Repo pull --ff-only
}

Set-Location $Repo
pnpm install
pnpm build
pnpm test
pnpm exec playwright install   # only needed for E2E tests

Write-Host "`nDone. Next: run 'gh auth login' so you can push. Add .env values by hand (never commit them)."
