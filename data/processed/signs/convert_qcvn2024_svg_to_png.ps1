$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$jsonPath = Join-Path $root 'signs_app_va_enums\QC2024.json'
$sourceRoot = Join-Path $root 'dataset_signs'
$outputRoot = Join-Path $root 'png_qcvn2024'
$canvasPoints = 512
$canvasPixels = 512

if (-not (Test-Path -LiteralPath $jsonPath -PathType Leaf)) {
  throw "Không tìm thấy JSON: $jsonPath"
}
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
  throw "Không tìm thấy thư mục SVG: $sourceRoot"
}

$rows = @(Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json | Where-Object {
  $_.qcvn -eq 'QCVN 41:2024/BGTVT' -and $_.image_required -eq $true -and $_.image_id
})
if ($rows.Count -eq 0) {
  throw 'Không có biển QCVN 2024 cần ảnh để chuyển.'
}

$duplicates = @($rows | Group-Object sign_code | Where-Object { -not $_.Name -or $_.Count -gt 1 })
if ($duplicates.Count -gt 0) {
  throw "Mã biển trống hoặc trùng: $($duplicates.Name -join ', ')"
}

$sourceByName = @{}
$duplicateSources = @()
foreach ($group in (Get-ChildItem -LiteralPath $sourceRoot -Filter '*.svg' -File -Recurse | Group-Object Name)) {
  $orderedSources = @($group.Group | Sort-Object FullName)
  $sourceByName[$group.Name] = $orderedSources[0].FullName
  if ($group.Count -gt 1) {
    $duplicateSources += "$($group.Name) -> $($orderedSources[0].FullName)"
  }
}
if ($duplicateSources.Count -gt 0) {
  Write-Warning "Tên SVG trùng; tiếp tục dùng bản đầu tiên theo thứ tự đường dẫn: $($duplicateSources -join '; ')"
}

$missing = @($rows | Where-Object { -not $sourceByName.ContainsKey((Split-Path -Leaf $_.image_id)) })
if ($missing.Count -gt 0) {
  throw "Thiếu SVG nguồn cho: $(($missing.sign_code) -join ', ')"
}

if (Test-Path -LiteralPath $outputRoot -PathType Container) {
  if (Get-ChildItem -LiteralPath $outputRoot -Force | Select-Object -First 1) {
    throw "Thư mục đầu ra đã có dữ liệu; để tránh ghi đè, hãy đổi tên hoặc dọn thủ công: $outputRoot"
  }
} else {
  New-Item -ItemType Directory -Path $outputRoot | Out-Null
}

$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.Visible = 0
  $presentation = $powerPoint.Presentations.Add()
  $presentation.PageSetup.SlideWidth = $canvasPoints
  $presentation.PageSetup.SlideHeight = $canvasPoints

  for ($i = 0; $i -lt $rows.Count; $i++) {
    $row = $rows[$i]
    $slide = $null
    $shape = $null
    try {
      $slide = $presentation.Slides.Add(1, 12)
      $sourcePath = $sourceByName[(Split-Path -Leaf $row.image_id)]
      $shape = $slide.Shapes.AddPicture($sourcePath, 0, -1, 0, 0, -1, -1)
      $scale = [Math]::Min(($canvasPoints - 32) / $shape.Width, ($canvasPoints - 32) / $shape.Height)
      $shape.Width = $shape.Width * $scale
      $shape.Height = $shape.Height * $scale
      $shape.Left = ($canvasPoints - $shape.Width) / 2
      $shape.Top = ($canvasPoints - $shape.Height) / 2

      $targetPath = Join-Path $outputRoot ($row.sign_code + '.png')
      $slide.Export($targetPath, 'PNG', $canvasPixels, $canvasPixels)
      if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf) -or (Get-Item -LiteralPath $targetPath).Length -eq 0) {
        throw "PowerPoint không tạo được PNG cho $($row.sign_code)."
      }
      Write-Progress -Activity 'Chuyển ảnh biển báo' -Status "$($i + 1)/$($rows.Count): $($row.sign_code)" -PercentComplete ((($i + 1) / $rows.Count) * 100)
    } finally {
      if ($shape) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape) }
      if ($slide) {
        $slide.Delete()
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($slide)
      }
    }
  }
} catch {
  Write-Host "Chuyển ảnh dừng giữa chừng. Chỉ ZIP thư mục khi đã có đủ $($rows.Count) ảnh. Lỗi: $_" -ForegroundColor Red
  throw
} finally {
  Write-Progress -Activity 'Chuyển ảnh biển báo' -Completed
  if ($presentation) {
    $presentation.Close()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  if ($powerPoint) {
    $powerPoint.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

$pngCount = @(Get-ChildItem -LiteralPath $outputRoot -Filter '*.png' -File).Count
if ($pngCount -ne $rows.Count) {
  throw "Số PNG không khớp: cần $($rows.Count), hiện có $pngCount. Chưa nên ZIP thư mục."
}
$totalBytes = (Get-ChildItem -LiteralPath $outputRoot -Filter '*.png' -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Đã chuyển đủ $pngCount ảnh ($([Math]::Round($totalBytes / 1MB, 2)) MB PNG). Thư mục để bạn tự ZIP: $outputRoot"
if ($totalBytes -gt 20MB) {
  Write-Warning 'Tổng PNG vượt giới hạn ZIP 20 MB của WebApp; cần giảm kích thước hoặc chia thành nhiều ZIP.'
}
