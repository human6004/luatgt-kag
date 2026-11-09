$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$Root = Split-Path -Parent $PSScriptRoot
$Settings = @{}
$ResolvedEnvFile = if ($EnvFile) { [IO.Path]::GetFullPath($EnvFile) } else { Join-Path (Split-Path -Parent $Root) '.env' }
if (!(Test-Path -LiteralPath $ResolvedEnvFile)) { throw 'Không tìm thấy WebApp env; truyền -EnvFile đúng installation.' }
foreach ($Line in [IO.File]::ReadAllLines($ResolvedEnvFile)) {
    if ($Line -match '^([A-Z_]+)=(.*)$') { $Settings[$Matches[1]] = $Matches[2] }
}
$Http = [Net.Http.HttpClient]::new()
$Http.Timeout = [TimeSpan]::FromSeconds(90)
function Invoke-TaskApi {
    param([string]$Method, [string]$Path, [object]$Body = $null, [string]$Token = '', [string]$File = '')
    $Request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), "$BaseUrl$Path")
    if ($Token) { $Request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token) }
    try {
        if ($File) {
            $Multipart = [Net.Http.MultipartFormDataContent]::new()
            $Stream = [IO.File]::OpenRead($File)
            $Part = [Net.Http.StreamContent]::new($Stream)
            $Part.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('application/zip')
            $Multipart.Add($Part, 'file', [IO.Path]::GetFileName($File))
            $Request.Content = $Multipart
        } elseif ($null -ne $Body) {
            $Request.Content = [Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 50 -Compress), [Text.Encoding]::UTF8, 'application/json')
        }
        $Response = $Http.SendAsync($Request).GetAwaiter().GetResult()
        try {
            $Text = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $Data = if ($Text) { $Text | ConvertFrom-Json } else { $null }
            if (!$Response.IsSuccessStatusCode) {
                throw "HTTP $([int]$Response.StatusCode) $Path : $($Data.message)"
            }
            return $Data
        } finally { $Response.Dispose() }
    } finally { $Request.Dispose() }
}
function Get-TaskAdminToken {
    $Auth = Invoke-TaskApi POST '/auth/login' @{email=$Settings.ADMIN_EMAIL; password=$Settings.ADMIN_PASSWORD}
    return $Auth.accessToken
}
function Wait-TaskBackend {
    $HealthUrl = ($BaseUrl -replace '/api/?$', '') + '/actuator/health'
    for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
        try {
            $Health = $Http.GetAsync($HealthUrl).GetAwaiter().GetResult()
            try { if ($Health.IsSuccessStatusCode) { return } } finally { $Health.Dispose() }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Backend chưa sẵn sàng. Kiểm tra docker compose logs backend rồi chạy lại.'
}
function Assert-Task { param([bool]$Condition, [string]$Message); if (!$Condition) { throw $Message } }
