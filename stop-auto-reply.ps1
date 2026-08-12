$ErrorActionPreference = 'SilentlyContinue'
$patterns = @('model-proxy.js', 'qq-onebot-relay.js', 'wechat-relay.exe')
Get-CimInstance Win32_Process | Where-Object { $cmd = $_.CommandLine; $cmd -and ($patterns | Where-Object { $cmd -like ('*' + $_ + '*') }) } | ForEach-Object {
  Write-Host "stopping $($_.ProcessId) $($_.Name) :: $($_.CommandLine)"
  Stop-Process -Id $_.ProcessId -Force
}
