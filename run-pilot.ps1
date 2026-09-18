$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host '[1/5] Validating module inventory'
Get-Content "$root\01-module-inventory\module_inventory.json" | ConvertFrom-Json | Out-Null
Write-Host '[2/5] Checking coverage engine'
python -m py_compile "$root\02-coverage-engine\coverage_engine.py"
Write-Host '[3/5] Building coverage API'
dotnet build "$root\03-coverage-api\CoveragePilot.Api.csproj" --nologo
Write-Host '[4/5] Installing/building dashboard'
Push-Location "$root\04-dashboard"
if (!(Test-Path node_modules)) { npm install }
npm run build
Pop-Location
Write-Host '[5/5] Validating browser extension'
Get-Content "$root\05-browser-extension\manifest.json" | ConvertFrom-Json | Out-Null
Write-Host 'Validation complete. Start the API and dashboard in separate terminals:'
Write-Host 'dotnet run --project .\03-coverage-api\CoveragePilot.Api.csproj'
Write-Host 'npm run dev --prefix .\04-dashboard -- --port 5174'
