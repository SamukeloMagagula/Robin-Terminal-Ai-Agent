<#
    Installs Robin from source on Windows.

        irm https://raw.githubusercontent.com/SamukeloMagagula/Robin-Terminal-Ai-Agent/main/install.ps1 | iex

    Deliberately boring: clone, install exactly what the lockfile says, build,
    link. Everything it does is a command you could run yourself, and it prints
    each one, because piping a script from the internet into a shell is a lot
    of trust to ask for silently.
#>

$ErrorActionPreference = 'Stop'

$Repo = if ($env:ROBIN_REPO) { $env:ROBIN_REPO } else { 'https://github.com/SamukeloMagagula/Robin-Terminal-Ai-Agent.git' }
$Dir  = if ($env:ROBIN_DIR)  { $env:ROBIN_DIR }  else { Join-Path $HOME '.robin-src' }
$MinNode = 18

function Say  ($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Fail ($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue))  { Fail 'git is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node $MinNode or newer is required. See https://nodejs.org." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue))  { Fail 'npm is required (it ships with Node).' }

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $MinNode) { Fail "Node $nodeMajor is too old; Robin needs $MinNode or newer." }

if (Test-Path (Join-Path $Dir '.git')) {
    Say "Updating $Dir"
    git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail 'git pull failed.' }
} else {
    Say "Cloning into $Dir"
    git clone --depth 1 $Repo $Dir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
}

Set-Location $Dir

# ci, not install: dependencies are exact-pinned and the lockfile is the point.
#
# --ignore-scripts is not paranoia here, it is what makes this work at all. npm
# compiles any dependency carrying a binding.gyp, and better-sqlite3 carries
# one — so without this, installing needs Visual Studio build tools and fails
# outright on a machine that has not got them. It also ships prebuilt binaries
# for every platform Robin runs on, so there is nothing to compile and nothing
# is lost. Not running arbitrary install scripts is the smaller benefit.
Say 'Installing dependencies'
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }

Say 'Building'
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'Build failed.' }

Say 'Linking the robin command'
npm link
if ($LASTEXITCODE -ne 0) {
    Write-Host '! npm link did not succeed.' -ForegroundColor Yellow
    Write-Host "  Use it in place instead:`n"
    Write-Host "    node $Dir\dist\cli.js chat`n"
    exit 0
}

Write-Host "`nInstalled. Next:`n" -ForegroundColor Green
Write-Host '    robin doctor      # check the install'
Write-Host '    robin login       # pick a provider'
Write-Host "    robin chat        # start talking`n"
