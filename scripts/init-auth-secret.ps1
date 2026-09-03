param(
    [string]$SecretPath = (Join-Path $PSScriptRoot '..\auth-secrets\auth-master-key')
)

$resolved = [IO.Path]::GetFullPath($SecretPath)
$parent = Split-Path -Parent $resolved
New-Item -ItemType Directory -Force -Path $parent | Out-Null
if (-not [IO.File]::Exists($resolved)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [IO.File]::WriteAllBytes($resolved, $bytes)
    if ($env:USERNAME) {
        try { & icacls.exe $resolved /inheritance:r /grant:r "$($env:USERNAME):(R)" *> $null } catch { }
    }
}
