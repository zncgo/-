[CmdletBinding()]
param(
    [string]$UserDataRoot = $(if ($env:RSSHUB_USER_DATA_DIR) { $env:RSSHUB_USER_DATA_DIR } else { 'E:\更新频率表\rsshub-console-data' }),
    [string]$SourceVolume = 'rsshub-cookie-data',
    [string]$SourceDirectory
)

$ErrorActionPreference = 'Stop'

function Get-FileCountInVolume([string]$VolumeName) {
    $count = & docker run --rm --mount "type=volume,src=$VolumeName,dst=/source,readonly" alpine:3.20 sh -ec 'find /source -type f -print | wc -l'
    if ($LASTEXITCODE -ne 0) { throw "无法只读访问 Docker 卷 $VolumeName。" }
    return [int]($count | Select-Object -Last 1)
}

function Test-JsonFiles([string]$Directory) {
    foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter '*.json') {
        try { $null = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { throw "迁移后的 JSON 校验失败：$($file.Name)" }
    }
}

function Test-PathInside([string]$Parent, [string]$Candidate) {
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $candidatePath = [IO.Path]::GetFullPath($Candidate)
    return $candidatePath.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $candidatePath -eq $parentPath
}

$root = [IO.Path]::GetFullPath($UserDataRoot)
$target = Join-Path $root 'cookies'
$marker = Join-Path $root '.cookie-migration.json'
if (Test-Path -LiteralPath $target) {
    $entries = @(Get-ChildItem -LiteralPath $target -Force)
    if ($entries.Count -gt 0) { throw "目标目录非空，已停止迁移：$target" }
    Remove-Item -LiteralPath $target -Force
}

New-Item -ItemType Directory -Path $root -Force | Out-Null
if ($SourceDirectory) {
    $directorySource = [IO.Path]::GetFullPath($SourceDirectory)
    if (-not (Test-Path -LiteralPath $directorySource -PathType Container)) { throw '旧 Cookie 源目录不存在。' }
    if (Test-PathInside $directorySource $target) { throw '源目录不能包含目标 Cookie 目录。' }
    $sourceFileCount = @(Get-ChildItem -LiteralPath $directorySource -Recurse -File).Count
} else {
    $sourceFileCount = Get-FileCountInVolume $SourceVolume
}
$temporary = Join-Path $root ('.cookies-migrate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary -Force | Out-Null

try {
    if ($SourceDirectory) {
        foreach ($entry in Get-ChildItem -LiteralPath $directorySource -Force) {
            Copy-Item -LiteralPath $entry.FullName -Destination $temporary -Recurse -Force
        }
    } else {
        & docker run --rm --mount "type=volume,src=$SourceVolume,dst=/source,readonly" --mount "type=bind,src=$temporary,dst=/target" alpine:3.20 sh -ec 'cp -a /source/. /target/'
        if ($LASTEXITCODE -ne 0) { throw "从 Docker 卷复制 Cookie 数据失败。" }
    }
    $targetFileCount = @(Get-ChildItem -LiteralPath $temporary -Recurse -File).Count
    if ($targetFileCount -ne $sourceFileCount) { throw "文件数量校验失败：源 $sourceFileCount，目标 $targetFileCount。" }
    Test-JsonFiles $temporary
    Move-Item -LiteralPath $temporary -Destination $target
    $summary = [ordered]@{ migratedAt = (Get-Date).ToUniversalTime().ToString('o'); sourceKind = $(if ($SourceDirectory) { 'directory' } else { 'volume' }); sourceVolume = $(if ($SourceDirectory) { $null } else { $SourceVolume }); fileCount = $targetFileCount; jsonValidated = $true }
    $markerTemp = "$marker.$([guid]::NewGuid().ToString('N')).tmp"
    $summary | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerTemp -Encoding utf8NoBOM
    Move-Item -LiteralPath $markerTemp -Destination $marker -Force
    $sourceDescription = if ($SourceDirectory) { '旧宿主机目录未修改。' } else { "旧卷 $SourceVolume 未删除。" }
    Write-Host "迁移完成：复制并校验 $targetFileCount 个文件。$sourceDescription"
} catch {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    throw
}
