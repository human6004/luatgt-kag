param(
    [Parameter(Mandatory=$true)][ValidateSet('250', '600')][string]$Set,
    [string]$BaseUrl = 'http://127.0.0.1:8080/api',
    [string]$EnvFile
)
. "$PSScriptRoot/api-common.ps1"
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    Wait-TaskBackend
    $Token = Get-TaskAdminToken
    $Rows = [IO.File]::ReadAllText((Join-Path $Root "docs/$Set/questions-draft.json")) | ConvertFrom-Json
    Assert-Task ($Rows.Count -gt 0) 'Bộ nhập phải có ít nhất một câu.'
    $Result = Invoke-TaskApi POST '/admin/imports/questions/confirm' @{rows=@($Rows); updateExisting=$false} $Token
    Write-Output "Câu hỏi: thêm $($Result.inserted), bỏ qua $($Result.skipped)."
    $Bank = @(Invoke-TaskApi GET '/admin/questions' -Token $Token)
    $Missing = @{}
    foreach ($Question in $Bank) {
        if (!$Question.data.imageKey) { $Missing[$Question.externalId] = $true }
    }
    $Audit = [IO.File]::ReadAllText((Join-Path $Root "docs/$Set/question-audit.json")) | ConvertFrom-Json
    $Archives = @($Audit.archives | ForEach-Object {
        if ($_ -notmatch '^question-images(-[0-9]+)?\.zip$') { throw 'Tên ZIP trong báo cáo không hợp lệ.' }
        Get-Item -LiteralPath (Join-Path $Root "docs/$Set/$_")
    })
    Assert-Task ($Archives.Count -gt 0) 'Chưa có ZIP ảnh.'
    foreach ($Archive in $Archives) {
        $TempZip = Join-Path ([IO.Path]::GetTempPath()) ("luatgt-" + [Guid]::NewGuid().ToString('N') + '.zip')
        try {
            $SourceZip = [IO.Compression.ZipFile]::OpenRead($Archive.FullName)
            $TargetZip = [IO.Compression.ZipFile]::Open($TempZip, [IO.Compression.ZipArchiveMode]::Create)
            $Count = 0
            try {
                foreach ($Entry in $SourceZip.Entries) {
                    if (!$Missing.ContainsKey([IO.Path]::GetFileNameWithoutExtension($Entry.Name))) { continue }
                    $Copy = $TargetZip.CreateEntry($Entry.Name)
                    $InputStream = $Entry.Open(); $OutputStream = $Copy.Open()
                    try { $InputStream.CopyTo($OutputStream) } finally { $InputStream.Dispose(); $OutputStream.Dispose() }
                    $Count++
                }
            } finally { $SourceZip.Dispose(); $TargetZip.Dispose() }
            if ($Count -eq 0) { Write-Output "$($Archive.Name): ảnh đã có, bỏ qua."; continue }
            $Images = Invoke-TaskApi POST '/admin/questions/images-zip' -Token $Token -File $TempZip
            Write-Output "$($Archive.Name): ghép $($Images.matched.Count) ảnh; chưa khớp $($Images.unmatched.Count)."
            Assert-Task ($Images.unmatched.Count -eq 0) 'Có ảnh chưa khớp; kiểm tra mã câu trong trang quản trị.'
        } finally { if (Test-Path -LiteralPath $TempZip) { Remove-Item -LiteralPath $TempZip } }
    }
    Write-Output 'Đã nhập nháp. Đối chiếu nguồn/đáp án/điểm liệt/ảnh tại Ngân hàng câu hỏi rồi duyệt xuất bản.'
} finally { $Http.Dispose() }
