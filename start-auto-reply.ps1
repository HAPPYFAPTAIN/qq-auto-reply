$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$wx = Join-Path $root 'wechat-relay'
$cfgPath = Join-Path $root 'auto-relay.config.json'

if (-not $env:OPENCODE_API_KEY) { Write-Host 'WARN: OPENCODE_API_KEY not in env; model proxy may fail' }

$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json

# 1) model proxy
$proxyOk = $false
try { $proxyOk = [bool](curl.exe -sS -m 2 http://127.0.0.1:8899/health 2>$null) } catch {}
if (-not $proxyOk) {
  Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList "`"$root\model-proxy.js`"" -WorkingDirectory $root
  Start-Sleep -Seconds 1
}

# 2) QQ relay（尊重配置开关）
if ($cfg.qq.enabled) {
  $qqRunning = [bool](Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'qq-onebot-relay\.js'})
  if (-not $qqRunning) {
    Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList "`"$root\qq-onebot-relay.js`"" -WorkingDirectory $root
    Start-Sleep -Seconds 1
  }
} else {
  Write-Host 'QQ auto-reply disabled in config; skip qq-onebot-relay.js'
}

# 3) WeChat relay
$wxOk = $false
try { $wxOk = [bool](curl.exe -sS -m 2 http://127.0.0.1:8787/api/status 2>$null) } catch {}
if (-not $wxOk) {
  Start-Process -WindowStyle Hidden -FilePath "$wx\wechat-relay.exe" -WorkingDirectory $wx
  Start-Sleep -Seconds 2
}

Write-Host 'model proxy:'; curl.exe -sS -m 3 http://127.0.0.1:8899/health
Write-Host "`nwechat relay:"; curl.exe -sS -m 3 http://127.0.0.1:8787/api/status
Write-Host "`nqq relay log:"; if (Test-Path "$root\logs\qq-onebot-relay.log") { Get-Content "$root\logs\qq-onebot-relay.log" -Tail 5 }
