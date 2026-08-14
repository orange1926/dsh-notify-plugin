# 重新应用 dsh-host-apiproxy 的设置白名单补丁（把 notify 命名空间暴露给浏览器）。
# 需要在每次 DSH 升级后重新运行一次（升级会替换 npx 缓存里的包）。
# 用法：powershell -ExecutionPolicy Bypass -File apply-apiproxy-patch.ps1
$ErrorActionPreference = 'Stop'

$link = 'C:\Users\john\.dsh\profiles\node_modules\@deepseek-ai\dsh-host-apiproxy'
if (-not (Test-Path $link)) {
  Write-Error '找不到 profile 里的 dsh-host-apiproxy，请确认 dsh 已安装'
  exit 1
}
$resolved = (Get-Item $link).Target
if (-not $resolved) { $resolved = $link }
$file = Join-Path $resolved 'lib\index.js'
if (-not (Test-Path $file)) { Write-Error "找不到 $file"; exit 1 }

$content = [System.IO.File]::ReadAllText($file)
if ($content -match '\"notify\"') {
  Write-Output '已打过补丁，无需重复。'
  exit 0
}
$replaced = $content -replace '\"web-search-deepseek\"(\s*\n\s*\])', '\"web-search-deepseek\",\n\t\"notify\"$1'
if ($replaced -eq $content) {
  Write-Error '替换失败：没有找到 WEB_SETTINGS_NAMESPACES 数组的结尾，请手动检查。'
  exit 1
}
[System.IO.File]::WriteAllText($file, $replaced, [System.Text.UTF8Encoding]::new($false))
Write-Output "已给 $file 打上 notify 白名单补丁。重启 dsh web 生效。"
