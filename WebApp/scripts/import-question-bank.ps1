param(
    [Parameter(Mandatory=$true)][ValidateSet('250', '600')][string]$Set,
    [string]$BaseUrl = 'http://127.0.0.1:8080/api',
    [string]$EnvFile
)
. "$PSScriptRoot/api-common.ps1"
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    Wait-TaskBackend
    $taskToken = Get-TaskAdminToken
    $taskRows = [IO.File]::ReadAllText((Join-Path $taskRoot "docs/$Set/questions-draft.json")) | ConvertFrom-Json
    Assert-Task ($taskRows.Count -gt 0) 'Bộ nhập phải có ít nhất một câu.'
    $taskResult = Invoke-TaskApi POST '/admin/imports/questions/confirm' @{rows=@($taskRows); updateExisting=$false} $taskToken
    Write-Output "Câu hỏi: thêm $($taskResult.inserted), bỏ qua $($taskResult.skipped)."
    $taskBank = @(Invoke-TaskApi GET '/admin/questions' -Token $taskToken)
    $taskMissing = @{}
    foreach ($taskQuestion in $taskBank) {
        if (!$taskQuestion.data.imageKey) { $taskMissing[$taskQuestion.externalId] = $true }
    }
    $taskAudit = [IO.File]::ReadAllText((Join-Path $taskRoot "docs/$Set/question-audit.json")) | ConvertFrom-Json
    $taskArchives = @($taskAudit.archives | ForEach-Object {
        if ($_ -notmatch '^question-images(-[0-9]+)?\.zip$') { throw 'Tên ZIP trong báo cáo không hợp lệ.' }
        Get-Item -LiteralPath (Join-Path $taskRoot "docs/$Set/$_")
    })
    Assert-Task ($taskArchives.Count -gt 0) 'Chưa có ZIP ảnh.'
    foreach ($taskArchive in $taskArchives) {
        $taskTempZip = Join-Path ([IO.Path]::GetTempPath()) ("luatgt-" + [Guid]::NewGuid().ToString('N') + '.zip')
        try {
            $taskSourceZip = [IO.Compression.ZipFile]::OpenRead($taskArchive.FullName)
            $taskTargetZip = [IO.Compression.ZipFile]::Open($taskTempZip, [IO.Compression.ZipArchiveMode]::Create)
            $taskCount = 0
            try {
                foreach ($taskEntry in $taskSourceZip.Entries) {
                    if (!$taskMissing.ContainsKey([IO.Path]::GetFileNameWithoutExtension($taskEntry.Name))) { continue }
                    $taskCopy = $taskTargetZip.CreateEntry($taskEntry.Name)
                    $taskInput = $taskEntry.Open(); $taskOutput = $taskCopy.Open()
                    try { $taskInput.CopyTo($taskOutput) } finally { $taskInput.Dispose(); $taskOutput.Dispose() }
                    $taskCount++
                }
            } finally { $taskSourceZip.Dispose(); $taskTargetZip.Dispose() }
            if ($taskCount -eq 0) { Write-Output "$($taskArchive.Name): ảnh đã có, bỏ qua."; continue }
            $taskImages = Invoke-TaskApi POST '/admin/questions/images-zip' -Token $taskToken -File $taskTempZip
            Write-Output "$($taskArchive.Name): ghép $($taskImages.matched.Count) ảnh; chưa khớp $($taskImages.unmatched.Count)."
            Assert-Task ($taskImages.unmatched.Count -eq 0) 'Có ảnh chưa khớp; kiểm tra mã câu trong trang quản trị.'
        } finally { if (Test-Path -LiteralPath $taskTempZip) { Remove-Item -LiteralPath $taskTempZip } }
    }
    Write-Output 'Đã nhập nháp. Đối chiếu nguồn/đáp án/điểm liệt/ảnh tại Ngân hàng câu hỏi rồi duyệt xuất bản.'
} finally { $taskHttp.Dispose() }
