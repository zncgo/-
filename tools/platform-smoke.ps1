param(
    [Parameter(Mandatory = $true)]
    [string]$WorkbookPath,
    [string]$UiContainer = 'rsshub-ui-1',
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\outputs\platform-smoke-report.json'),
    [int]$SuccessesPerPlatform = 3,
    [int]$MaxCandidatesPerPlatform = 30,
    [int]$RequestTimeoutSeconds = 95,
    [string[]]$SkipPlatforms = @(),
    [string[]]$OnlyPlatforms = @(),
    # Start-Process 会把数组参数拆成位置参数；后台运行时使用此逗号分隔值。
    [string]$SkipPlatformsCsv = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$skipPlatformSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($platform in @($SkipPlatforms) + @($SkipPlatformsCsv -split ',')) {
    if (-not [string]::IsNullOrWhiteSpace($platform)) { [void]$skipPlatformSet.Add($platform.Trim()) }
}
$onlyPlatformSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($platform in $OnlyPlatforms) {
    if (-not [string]::IsNullOrWhiteSpace($platform)) { [void]$onlyPlatformSet.Add($platform.Trim()) }
}

$platforms = [ordered]@{
    '抖音' = @('douyin.com')
    '小红书' = @('xiaohongshu.com', 'xhslink.com', 'xhslink.cn')
    '快手' = @('kuaishou.com')
    'B站' = @('bilibili.com', 'b23.tv')
    '微博' = @('weibo.com', 'weibo.cn', 't.cn')
    '知乎' = @('zhihu.com')
    '今日头条' = @('toutiao.com')
    '网易新闻' = @('163.com', '163.lu')
    '懂车帝' = @('dongchedi.com', 'dcdapp.com')
    '一点资讯' = @('yidianzixun.com')
    'UC大鱼' = @('uc.cn', 'dayu.com')
    '搜狐新闻' = @('sohu.com')
    '腾讯新闻' = @('inews.qq.com', 'news.qq.com', 'new.qq.com', 'om.qq.com')
    '凤凰新闻' = @('ifeng.com')
    '百度新闻' = @('baijiahao.baidu.com', 'mbd.baidu.com')
    '汽车之家' = @('autohome.com.cn', 'athm.cn')
    '爱卡汽车' = @('xcar.com.cn')
    '汽车头条' = @('qctt.cn')
    '太平洋汽车' = @('pcauto.com.cn')
    '网上车市' = @('cheshi.com')
    '易车' = @('yiche.com')
    '爱奇艺' = @('iqiyi.com')
    '优酷/土豆视频' = @('youku.com', 'tudou.com')
    '腾讯视频' = @('v.qq.com')
    '美拍' = @('meipai.com')
    '搜狐视频' = @('tv.sohu.com', 'my.tv.sohu.com')
    '56视频' = @('56.com')
    '秒拍' = @('miaopai.com')
    '西瓜视频' = @('ixigua.com')
}

function Get-WorkbookUrls {
    param([string]$Path)

    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $urls = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -notmatch '^xl/worksheets/sheet\d+\.xml$') { continue }
            $reader = [IO.StreamReader]::new($entry.Open())
            try { $xmlText = $reader.ReadToEnd() } finally { $reader.Dispose() }
            foreach ($match in [regex]::Matches($xmlText, 'https?://[^<\s]+')) {
                $url = [System.Net.WebUtility]::HtmlDecode($match.Value).TrimEnd(')', ']', '，', ',', '。', ';', '；')
                if ($url -notmatch 'schemas\.openxmlformats') { $urls.Add($url) }
            }
        }
        return $urls | Select-Object -Unique
    } finally {
        $archive.Dispose()
    }
}

function Get-PlatformForUrl {
    param([string]$Url)

    try { $urlHost = (([uri]$Url).Host.ToLowerInvariant() -replace '^www\.', '') } catch { return $null }
    if ($urlHost -eq 'tv.sohu.com' -or $urlHost -eq 'my.tv.sohu.com') { return '搜狐视频' }
    if ($urlHost -eq 'v.qq.com') { return '腾讯视频' }
    foreach ($pair in $platforms.GetEnumerator()) {
        foreach ($domain in $pair.Value) {
            if ($urlHost -eq $domain -or $urlHost.EndsWith(".$domain")) { return $pair.Key }
        }
    }
    return $null
}

function Test-ProfileCandidate {
    param([string]$Platform, [string]$Url)

    try {
        $uri = [uri]$Url
        $urlHost = $uri.Host.ToLowerInvariant()
        $path = $uri.AbsolutePath
    } catch { return $false }
    switch ($Platform) {
        '小红书' { return $urlHost -match '(^|\.)xiaohongshu\.com$' -and $path -match '^/user/profile/[A-Za-z0-9]+' }
        '抖音' { return ($urlHost -match '(^|\.)douyin\.com$' -and ($urlHost -match '^v\.' -or $path -match '^/user/')) }
        '快手' { return ($urlHost -match '(^|\.)kuaishou\.com$' -and ($urlHost -match '^v\.' -or $path -match '^/profile/')) }
        'B站' { return $urlHost -match '(^|\.)bilibili\.com$' -and $urlHost -match '^space\.' -and $path -match '^/\d+' }
        '微博' { return ($urlHost -match '(^|\.)weibo\.com$' -and $path -match '^/(?:u/\d+|[A-Za-z0-9_]+)$') -or ($urlHost -eq 'weibo.cn' -and $path -match '^/u/\d+') }
        default { return $true }
    }
}

function Invoke-CollectorQuery {
    param([string]$Url, [int]$TimeoutSeconds)

    $encoded = [uri]::EscapeDataString($Url)
    # docker exec 被 Stop-Job 终止时，容器内 node 可能继续存活并占住 Browserless。
    # 因此在容器内也设一个硬超时，确保每条候选都能自行退出。
    $timeoutMilliseconds = [Math]::Max(1000, $TimeoutSeconds * 1000)
    # docker exec 在 Windows 控制台可能错误转码中文 JSON；容器端转为 ASCII Base64，宿主端再按 UTF-8 还原。
    $script = "const timeout = setTimeout(() => { process.stderr.write('__CLIENT_TIMEOUT__'); process.exit(124); }, $timeoutMilliseconds); fetch('http://127.0.0.1:3000/api/query?url=$encoded').then(async response => { process.stdout.write(Buffer.from(await response.text(), 'utf8').toString('base64')); clearTimeout(timeout); }).catch(error => { clearTimeout(timeout); process.stderr.write(String(error)); process.exit(1) });"
    $job = Start-Job -ScriptBlock {
        param($Container, $NodeScript)
        & docker exec $Container node -e $NodeScript 2>&1
    } -ArgumentList $UiContainer, $script
    if (-not (Wait-Job -Job $job -Timeout ($TimeoutSeconds + 10))) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force
        return [pscustomobject]@{ ok = $false; status = 'request_timeout'; error = "采集请求超过 $TimeoutSeconds 秒未返回" }
    }
    $raw = Receive-Job -Job $job
    $jobState = $job.State
    Remove-Job -Job $job -Force
    if ($jobState -ne 'Completed') {
        return [pscustomobject]@{ ok = $false; status = 'transport_error'; error = ($raw -join "`n") }
    }
    $encodedResponse = ($raw -join '').Trim()
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedResponse))
        return ($json | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ ok = $false; status = 'invalid_response'; error = ($raw -join "`n") }
    }
}

$allUrls = Get-WorkbookUrls -Path $WorkbookPath
$candidates = @{}
foreach ($platform in $platforms.Keys) { $candidates[$platform] = [System.Collections.Generic.List[string]]::new() }
foreach ($url in $allUrls) {
    $platform = Get-PlatformForUrl -Url $url
    if ($platform -and (Test-ProfileCandidate -Platform $platform -Url $url)) { $candidates[$platform].Add($url) }
}

# 对已人工确认有效的样本优先验证，避免旧账号短链耗尽整个平台的测试时间。
$preferredUrls = @{
    '快手' = @('https://v.kuaishou.com/PO5Q2j', 'https://v.kuaishou.com/WZfBhz', 'https://v.kuaishou.com/QTVXWF')
}
foreach ($platform in $preferredUrls.Keys) {
    $ordered = [System.Collections.Generic.List[string]]::new()
    foreach ($preferred in $preferredUrls[$platform]) {
        foreach ($candidate in $candidates[$platform]) {
            if ($candidate.TrimEnd('/') -eq $preferred.TrimEnd('/')) { $ordered.Add($candidate) }
        }
    }
    foreach ($candidate in $candidates[$platform]) {
        if (-not $ordered.Contains($candidate)) { $ordered.Add($candidate) }
    }
    $candidates[$platform] = $ordered
}

$report = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    workbook = $WorkbookPath
    workbookUrlCount = @($allUrls).Count
    targetSuccessesPerPlatform = $SuccessesPerPlatform
    platforms = [ordered]@{}
}

foreach ($platform in $platforms.Keys) {
    if ($onlyPlatformSet.Count -gt 0 -and -not $onlyPlatformSet.Contains($platform)) { continue }
    if ($skipPlatformSet.Contains($platform)) { continue }
    $successes = [System.Collections.Generic.List[object]]::new()
    $attempts = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $sessionBlockedStreak = 0
    foreach ($url in $candidates[$platform]) {
        if ($successes.Count -ge $SuccessesPerPlatform -or $attempts.Count -ge $MaxCandidatesPerPlatform) { break }
        if (-not $seen.Add($url)) { continue }
        $data = Invoke-CollectorQuery -Url $url -TimeoutSeconds $RequestTimeoutSeconds
        $record = [ordered]@{
            inputUrl = $url
            ok = [bool]$data.ok
            status = [string]$data.status
            resolvedUrl = [string]$data.resolvedUrl
            latestTimeBeijing = [string]$data.latestTimeBeijing
            error = [string]$data.error
        }
        $attempts.Add([pscustomobject]$record)
        if ($data.ok -and $data.status -eq 'success' -and $data.latestTimeBeijing) {
            $successes.Add([pscustomobject]$record)
            $sessionBlockedStreak = 0
        } elseif ($record.error -match 'Cookie 故障转移失败|主页跳转到登录页|没有可用的.+Cookie|HTTP 403|HTTP 503|采集请求超过') {
            $sessionBlockedStreak += 1
            if ($sessionBlockedStreak -ge 3) { break }
        } else {
            $sessionBlockedStreak = 0
        }
    }
    $report.platforms[$platform] = [ordered]@{
        candidateCount = $candidates[$platform].Count
        passed = ($successes.Count -ge $SuccessesPerPlatform)
        successes = @($successes)
        attempts = @($attempts)
    }
    $directory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    Write-Host ("[{0}] {1}/{2} 有效主页已取到时间" -f $platform, $successes.Count, $SuccessesPerPlatform)
}

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "REPORT=$OutputPath"
