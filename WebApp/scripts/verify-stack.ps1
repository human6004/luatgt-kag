param([string]$BaseUrl = 'http://127.0.0.1:8080/api', [switch]$WithExam, [string]$EnvFile)
. "$PSScriptRoot/api-common.ps1"
try {
    Wait-TaskBackend
    $Admin = Get-TaskAdminToken
    $Infra = Invoke-TaskApi GET '/admin/infrastructure' -Token $Admin
    foreach ($Name in @('MySQL','Redis','MinIO')) {
        Assert-Task ($Infra.$Name -eq 'UP') "$Name chưa khả dụng."
    }
    Write-Output 'PASS: MySQL, Redis, MinIO.'
    # Creates test accounts and retains their practice/exam history; never changes the content bank.
    $Suffix = [Guid]::NewGuid().ToString('N')
    $Password = [Guid]::NewGuid().ToString('N')
    $User = Invoke-TaskApi POST '/auth/register' @{name='Kiểm thử tích hợp';email="check-$Suffix@example.test";password=$Password}
    Assert-Task ($User.user.role -eq 'USER') 'Đăng ký phải chỉ tạo USER.'
    $Denied = $false
    try { $null = Invoke-TaskApi GET '/admin/users' -Token $User.accessToken } catch { if ($_.Exception.Message -match '^HTTP 403') { $Denied=$true } else { throw } }
    Assert-Task $Denied 'USER đọc được API quản trị.'
    foreach ($Kind in @('questions','signs','documents','penalties')) {
        $null = Invoke-TaskApi GET "/$Kind" -Token $User.accessToken
    }
    Write-Output 'PASS: tự đăng ký USER, phân quyền và API nội dung.'
    if ($WithExam) {
        $Other = Invoke-TaskApi POST '/auth/register' @{name='Kiểm thử sở hữu';email="other-$Suffix@example.test";password=$Password}
        $Bank = @(Invoke-TaskApi GET '/admin/questions' -Token $Admin)
        $Answers = @{}
        foreach ($Question in $Bank) { $Answers[$Question.id] = $Question.data.correctAnswer }
        $Exam = Invoke-TaskApi POST '/exams' -Token $User.accessToken
        Assert-Task ($Exam.questions.Count -eq 30) 'Đề phải đủ 30 câu.'
        $Denied = $false
        try { $null = Invoke-TaskApi GET "/exams/$($Exam.id)" -Token $Other.accessToken } catch { if ($_.Exception.Message -match '^HTTP 404') { $Denied=$true } else { throw } }
        Assert-Task $Denied 'Tài khoản khác đọc được bài thi.'
        foreach ($Question in $Exam.questions) {
            Assert-Task (!($Question.PSObject.Properties.Name -contains 'correctAnswer')) 'Lộ đáp án khi đang thi.'
            Assert-Task (!($Question.PSObject.Properties.Name -contains 'critical')) 'Lộ cờ điểm liệt khi đang thi.'
            Assert-Task ($Answers.ContainsKey($Question.questionId)) 'Không tìm thấy đáp án quản trị.'
            $null = Invoke-TaskApi PUT "/exams/$($Exam.id)/answers/$($Question.questionId)" @{selected=[int]$Answers[$Question.questionId]} $User.accessToken
            if ($Question.imageKey) {
                # Check protected snapshot media through the same HTTP client.
                $Request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "$BaseUrl/exams/$($Exam.id)/questions/$($Question.questionId)/media")
                $Request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$User.accessToken)
                try {
                    $Response = $Http.SendAsync($Request).GetAwaiter().GetResult()
                    try { Assert-Task $Response.IsSuccessStatusCode 'Không tải được ảnh bài thi từ MinIO.' } finally { $Response.Dispose() }
                } finally { $Request.Dispose() }
            }
        }
        $Result = Invoke-TaskApi POST "/exams/$($Exam.id)/submit" -Token $User.accessToken
        Assert-Task ($Result.score -eq 30 -and $Result.passed) 'Chấm đúng tất cả phải đạt 30/30.'
        $Repeat = Invoke-TaskApi POST "/exams/$($Exam.id)/submit" -Token $User.accessToken
        Assert-Task ($Repeat.score -eq 30 -and $Repeat.submittedAt -eq $Result.submittedAt) 'Nộp lại thay đổi kết quả.'
        $Question = $Exam.questions[0]
        $Study = Invoke-TaskApi POST "/study/$($Question.questionId)/answer" @{selected=[int]$Answers[$Question.questionId]} $User.accessToken
        Assert-Task $Study.correct 'Ôn tập chấm sai đáp án.'
        $Progress = @(Invoke-TaskApi GET '/progress' -Token $User.accessToken)
        Assert-Task (($Progress | Measure-Object -Property practiced -Sum).Sum -ge 1) 'Không lưu tiến độ ôn tập.'
        Write-Output 'PASS: đề B, quyền sở hữu, ẩn đáp án, ảnh MinIO, chấm/nộp lại và tiến độ.'
    } else { Write-Output 'SKIP: thi/ôn tập; sau khi duyệt ngân hàng, chạy lại với -WithExam.' }
    $null = Invoke-TaskApi POST '/auth/logout' -Token $User.accessToken
    $Revoked = $false
    try { $null = Invoke-TaskApi GET '/auth/me' -Token $User.accessToken } catch { if ($_.Exception.Message -match '^HTTP 401') { $Revoked=$true } else { throw } }
    Assert-Task $Revoked 'JWT chưa thu hồi sau đăng xuất.'
    Write-Output 'PASS: thu hồi JWT. KAG chưa thuộc đợt kiểm tra này.'
} finally { $Http.Dispose() }
