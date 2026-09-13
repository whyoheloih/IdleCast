param([switch]$Restart, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$repoPath = $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (!(Test-Path -LiteralPath $nodePath)) { throw 'Install Node 24 or newer before starting IdleCast.' }
$env:PATH = (Split-Path $nodePath) + ';C:\Program Files\ffmpeg;' + $env:PATH
Push-Location -LiteralPath $repoPath
try {
  $running = $false
  try { $running = (Invoke-WebRequest 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2 -Proxy $null).StatusCode -eq 200 } catch {}
  if ($Restart -and $running) {
    $ownerPid = [int](Get-Content -LiteralPath (Join-Path $repoPath 'data\owner.pid'))
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid"
    $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen
    if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch 'server/index.ts' -or $listener.OwningProcess -notcontains $ownerPid) { throw 'Port 3000 does not match this IdleCast instance.' }
    $stopCode = @'
process.loadEnvFile();
const origin=process.env.PUBLIC_ORIGIN||'http://localhost:3000';
const headers={Origin:origin,'Content-Type':'application/json'};
const login=await fetch('http://127.0.0.1:3000/api/login',{method:'POST',headers,body:JSON.stringify({password:process.env.ADMIN_PASSWORD})});
if(!login.ok)throw Error('Could not authenticate to stop IdleCast');
const cookie=login.headers.get('set-cookie').split(';')[0];
const stop=await fetch('http://127.0.0.1:3000/api/stop',{method:'POST',headers:{...headers,Cookie:cookie}});
if(!stop.ok)throw Error('Could not stop playback');
'@
    & $nodePath --input-type=module -e $stopCode
    if ($LASTEXITCODE -ne 0) { throw 'Restart stopped: could not safely stop playback.' }
    Stop-Process -Id $ownerPid
    $running = $false
  }
  if (!$running) {
    New-Item -ItemType Directory -Force -Path (Join-Path $repoPath 'data') | Out-Null
    Start-Process -FilePath $nodePath -ArgumentList '--import tsx server/index.ts' -WorkingDirectory $repoPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $repoPath 'data/server.log') -RedirectStandardError (Join-Path $repoPath 'data/server-error.log') | Out-Null
    for ($attempt=0; $attempt -lt 30; $attempt++) {
      Start-Sleep -Milliseconds 500
      try { if ((Invoke-WebRequest 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 1 -Proxy $null).StatusCode -eq 200) { $running=$true; break } } catch {}
    }
    if (!$running) { throw 'IdleCast did not start. Check data\server-error.log.' }
  }
  if (!$NoBrowser) { Start-Process 'http://localhost:3000' }
} finally { Pop-Location }
