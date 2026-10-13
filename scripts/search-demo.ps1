$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:BLIBS_DATA_DIR = Join-Path (Get-Location) '.demo-data'
$env:BLIBS_DEMO = '1'
$env:BLIBS_UI_PORT = '4312'
$env:PROXY_PORT = '4321'
$env:BLIBS_EMBEDDING_URL = 'http://127.0.0.1:4322'
$env:BLIBS_GENERATION_URL = 'http://127.0.0.1:4323'
$env:BLIBS_EMBEDDING_MODEL = 'bge-small-en-v1.5-q8_0:f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804'
$env:BLIBS_GENERATION_MODEL = 'qwen2.5-1.5b-instruct-q4_k_m:6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
npx tsx scripts/seed-search-demo.ts
if ($LASTEXITCODE) { throw 'Synthetic demo seed failed.' }
npm start
