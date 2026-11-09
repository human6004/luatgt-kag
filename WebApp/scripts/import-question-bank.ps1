param(
    [Parameter(Mandatory=$true)][ValidateSet('250', '600')][string]$Set,
    [Parameter(Mandatory=$true)][ValidateScript({
        $ParsedId = [Guid]::Empty
        if ($_.Length -ne 36 -or ![Guid]::TryParseExact($_, 'D', [ref]$ParsedId)) {
            throw 'SetId phải là GUID chuẩn dạng xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'
        }
        $true
    })][string]$SetId,
    [switch]$Force,
    [string]$BaseUrl = 'http://127.0.0.1:8080/api',
    [string]$EnvFile
)
$SetId = ([Guid]$SetId).ToString('D')
$Prefix = "[Bộ $Set | $SetId]"
. "$PSScriptRoot/api-common.ps1"
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    Wait-TaskBackend
    $Token = Get-TaskAdminToken
    $Sets = @(Invoke-TaskApi GET '/admin/questions/sets' -Token $Token)
    $TargetSet = @($Sets | Where-Object { $_.set_id -eq $SetId })
    Assert-Task ($TargetSet.Count -eq 1) "$Prefix Không tìm thấy bộ câu hỏi; kiểm lại SetId của installation này."
    $Existing = @(Invoke-TaskApi GET '/admin/questions' -Token $Token | Where-Object { $_.data.questionSetId -eq $SetId })
    # question_count chỉ đếm câu đã vào catalog; kiểm cả bản nháp trước khi ghi.
    if ($TargetSet[0].question_count -gt 0 -or $Existing.Count -gt 0) {
        Write-Warning "$Prefix Bộ đã có câu hỏi hoặc bản nháp. Nhập tiếp sẽ bỏ qua mã đã tồn tại."
        Assert-Task ([bool]$Force) "$Prefix Chỉ chạy lại với -Force sau khi xác nhận đúng bộ đích."
    }
    $Rows = [IO.File]::ReadAllText((Join-Path $Root "docs/$Set/questions-draft.json")) | ConvertFrom-Json
    Assert-Task ($Rows.Count -gt 0) 'Bộ nhập phải có ít nhất một câu.'
    $Result = Invoke-TaskApi POST '/admin/imports/questions/confirm' @{rows=@($Rows); updateExisting=$false; questionSetId=$SetId} $Token
    Write-Output "$Prefix Câu hỏi: thêm $($Result.inserted), bỏ qua $($Result.skipped), cập nhật $($Result.updated)."
    $Bank = @(Invoke-TaskApi GET '/admin/questions' -Token $Token | Where-Object { $_.data.questionSetId -eq $SetId })
    $Missing = @{}
    foreach ($Question in $Bank) {
        if (!$Question.data.imageKey) {
            $Code = [string]$Question.data.sourceExternalId
            if ([string]::IsNullOrWhiteSpace($Code)) { $Code = $Question.externalId }
            $Missing[$Code] = $true
        }
    }
    $Audit = [IO.File]::ReadAllText((Join-Path $Root "docs/$Set/question-audit.json")) | ConvertFrom-Json
    $Archives = @($Audit.archives | ForEach-Object {
        if ($_ -notmatch '^question-images(-[0-9]+)?\.zip$') { throw 'Tên ZIP trong báo cáo không hợp lệ.' }
        Get-Item -LiteralPath (Join-Path $Root "docs/$Set/$_")
    })
    Assert-Task ($Archives.Count -gt 0) 'Chưa có ZIP ảnh.'
    $MatchedImages = 0; $UnmatchedImages = 0
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
            if ($Count -eq 0) { Write-Output "$Prefix $($Archive.Name): ảnh đã có, bỏ qua."; continue }
            $Images = Invoke-TaskApi POST "/admin/questions/images-zip?questionSetId=$SetId" -Token $Token -File $TempZip
            $MatchedImages += $Images.matched.Count; $UnmatchedImages += $Images.unmatched.Count
            Write-Output "$Prefix $($Archive.Name): ghép $($Images.matched.Count) ảnh; chưa khớp $($Images.unmatched.Count)."
            Assert-Task ($Images.unmatched.Count -eq 0) 'Có ảnh chưa khớp; kiểm tra mã câu trong trang quản trị.'
        } finally { if (Test-Path -LiteralPath $TempZip) { Remove-Item -LiteralPath $TempZip } }
    }
    Write-Output "$Prefix Tổng kết: thêm $($Result.inserted), bỏ qua $($Result.skipped), cập nhật $($Result.updated); ảnh đã ghép $MatchedImages, chưa khớp $UnmatchedImages."
    Write-Output 'Đã nhập nháp. Đối chiếu nguồn/đáp án/điểm liệt/ảnh tại Ngân hàng câu hỏi rồi duyệt xuất bản.'
} finally { $Http.Dispose() }
