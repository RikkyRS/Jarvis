$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
npm install
npm run build
npm install -g .
Write-Host "JARVIS no PATH. Teste: jarvis doctor"
Write-Host "Em qualquer projeto: jarvis planeje `"sua tarefa`""
