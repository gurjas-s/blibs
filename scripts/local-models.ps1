param([ValidateSet('Start','Stop')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $projectDir '.local-models'
$stateFile = Join-Path $modelDir 'processes.json'
if ($Action -eq 'Stop') {
  if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    foreach ($modelPid in @($state.embedding, $state.generation)) {
      $process = Get-Process -Id $modelPid -ErrorAction SilentlyContinue
      if ($process -and $process.Path -eq [System.IO.Path]::GetFullPath((Join-Path $modelDir 'runtime/llama-server.exe'))) { Stop-Process -Id $modelPid -Force }
    }
  }
  return
}
$runtimePath = Join-Path $modelDir 'runtime/llama-server.exe'
$embedPath = Join-Path $modelDir 'embedding/bge-small-en-v1.5-q8_0.gguf'
$generatePath = Join-Path $modelDir 'generation/qwen2.5-1.5b-instruct-q4_k_m.gguf'
foreach ($file in @($runtimePath, $embedPath, $generatePath)) { if (!(Test-Path -LiteralPath $file)) { throw "Missing $file. Read docs/conversation-search.md for the free download setup." } }
$hashes = @{
  $embedPath = 'F046DB1DC724CF4F6F0A0C5917E922823B73EB1D27B8F9A9C2797F7866974804'
  $generatePath = '6A1A2EB6D15622BF3C96857206351BA97E1AF16C30D7A74EE38970E434E9407E'
}
foreach ($file in $hashes.Keys) { if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $hashes[$file]) { throw "Model checksum mismatch: $file" } }
foreach ($port in @(4322,4323)) { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Port $port is already in use. Stop the previous demo models first." } }
$embedArgs = @('-m',('"'+$embedPath+'"'),'--embedding','--pooling','cls','--host','127.0.0.1','--port','4322','-t','2','-tb','2','-c','512','-np','1','--ubatch-size','512')
$generateArgs = @('-m',('"'+$generatePath+'"'),'--host','127.0.0.1','--port','4323','-t','2','-tb','2','-c','4096','-np','1')
$embed = Start-Process -FilePath $runtimePath -ArgumentList $embedArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $modelDir 'embedding.log') -RedirectStandardError (Join-Path $modelDir 'embedding.err.log')
$generate = Start-Process -FilePath $runtimePath -ArgumentList $generateArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $modelDir 'generation.log') -RedirectStandardError (Join-Path $modelDir 'generation.err.log')
@{embedding=$embed.Id;generation=$generate.Id} | ConvertTo-Json | Set-Content -LiteralPath $stateFile
Write-Output 'Local model servers started on 127.0.0.1:4322 and :4323 (two CPU threads each).'
