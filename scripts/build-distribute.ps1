# Friend distribution ZIP package generator
# Usage: pwsh scripts/build-distribute.ps1  or  npm run dist
#
# Prerequisite: 'npm run build' was executed; dist/LineageMPTimer-<version>-portable.exe exists
# Output: dist/LineageMPTimer-v<version>.zip (portable + README + quickstart + changelog)
#
# Note: filenames inside the zip are ASCII to avoid PowerShell 5.1 ANSI codepage issues.
# File contents may contain Korean (UTF-8 with BOM is used so Notepad displays correctly).

param(
  [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
  $pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.version
}

$DistDir     = Join-Path $Root 'dist'
$PackageName = "LineageMPTimer-v$Version"
$StagingDir  = Join-Path $DistDir $PackageName
$ZipPath     = Join-Path $DistDir "$PackageName.zip"
$Portable    = Join-Path $DistDir "LineageMPTimer-$Version-portable.exe"

if (-not (Test-Path $Portable)) {
  Write-Error "Portable exe not found: $Portable. Run 'npm run build' first."
  exit 1
}

Write-Host "Building distribution package -- v$Version"

if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
if (Test-Path $ZipPath)    { Remove-Item -Force $ZipPath }
New-Item -ItemType Directory -Path $StagingDir | Out-Null

# 1) Copy portable exe
Copy-Item $Portable -Destination (Join-Path $StagingDir "LineageMPTimer-$Version-portable.exe")
Write-Host "  + portable exe"

# 2) Copy README (사용설명서.md content)
$ManualSrc = Join-Path $Root '사용설명서.md'
if (Test-Path $ManualSrc) {
  Copy-Item $ManualSrc -Destination (Join-Path $StagingDir 'README.md')
  Write-Host "  + README.md (manual content in Korean)"
}

# Helper: write UTF-8 with BOM (Notepad-friendly for Korean content on Windows)
function Write-Utf8Bom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($true))
}

# 3) QUICKSTART.txt (Korean content, ASCII filename)
$QuickStart = "[리니지 MP 타이머 v$Version - 1분 빠른 시작]`r`n`r`n" +
"1. LineageMPTimer-$Version-portable.exe 더블클릭`r`n" +
"   * Windows Defender 경고가 뜨면 [추가 정보] -> [실행]`r`n" +
"   * 개인 빌드라 서명이 없을 뿐 안전합니다`r`n`r`n" +
"2. 입력 탭에서 [최대 MP] 입력 (예: 235)`r`n`r`n" +
"3. OCR/아이템 탭 -> [자동 모드 (NEW)] 선택`r`n" +
"   -> [게임 화면 영역 지정] 버튼 한 번 드래그 (게임 창 전체)`r`n" +
"   -> MP / 경험치 / 레벨 / 아데나 위치 자동 탐지`r`n`r`n" +
"4. 메인 탭에서 자동으로 MP 게이지 + 카운트다운 동작`r`n`r`n" +
"자세한 사용법은 README.md 참고. 즐거운 사냥하세요!`r`n"
Write-Utf8Bom -Path (Join-Path $StagingDir 'QUICKSTART.txt') -Content $QuickStart
Write-Host "  + QUICKSTART.txt"

# 4) CHANGELOG.txt
$Changelog = "[LineageMPTimer v$Version - 변경내역]`r`n`r`n" +
"== v1.4.1 자동 모드 root cause 5종 수정 (2026-05-06) ==`r`n" +
"- EXP가 0% 가까울 때(레벨업 직후) 자동 탐지 실패 -> LV 텍스트 직접 검출로 해결`r`n" +
"- HP/MP 캡처 스트림 누락(자동 모드 gameRegion 빠짐) 수정`r`n" +
"- HP/EXP 위치 검증을 인접도 기반으로 완화 -> 사용자 캐릭터 정보 패널 layout 지원`r`n" +
"- ADENA 수동 override stale sourceId 자동 해제`r`n" +
"- multi-candidate combinatorial search -> 파티 HP / 채팅 빨간 텍스트 회피`r`n`r`n" +
"== 새로운 기능 - 자동 ROI 탐지 (v1.4.0) ==`r`n" +
"- 게임 화면 영역 1개만 드래그하면 MP/경험치/레벨/아데나 위치 자동 탐지`r`n" +
"- 셋업 시간 5분 -> 1분`r`n" +
"- HSV 색상 분석으로 HP 바 / MP 바 / EXP 바 / 아데나 아이콘 자동 인식`r`n" +
"- 게임 창 이동에 더 강함`r`n`r`n" +
"== OCR 안정화 (v1.3.22 안전망 통합) ==`r`n" +
"- 자릿수 misread (예: '88' -> '8' 1자리 인식) 영원 폐기 -> 20회 일관 검증 흡수`r`n" +
"- 사용자 직접 입력 없이도 anchor 자동 회복 가능`r`n" +
"- 영역 너무 좁게 (height < 18px) 지정 시 친절한 경고`r`n" +
"- 다중 캔버스 OCR ensemble (최대 18 results 다수결) 유지`r`n" +
"- 휘도 mode white extraction (베이지 글자 대응) 유지`r`n" +
"- 멀티 모니터 displayId 일치 검증 유지`r`n`r`n" +
"== UX/UI 개선 ==`r`n" +
"- 자동 모드 기본 추천, 수동 모드는 고급/fallback`r`n" +
"- 자동 모드 첫 선택 시 3단계 온보딩 안내`r`n" +
"- ROI 탐지 실패 시 단계별 가이드`r`n" +
"- ROI 상태 패널 실시간 갱신 + 오버레이 프리뷰`r`n`r`n" +
"이전 수동 모드도 그대로 사용 가능 -- 자동/수동 토글로 즉시 전환`r`n"
Write-Utf8Bom -Path (Join-Path $StagingDir 'CHANGELOG.txt') -Content $Changelog
Write-Host "  + CHANGELOG.txt"

# 5) Compress to ZIP
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($StagingDir, $ZipPath)
Write-Host "  + zipped"

# 6) Cleanup staging
Remove-Item -Recurse -Force $StagingDir

$Size = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Host ""
Write-Host "DONE: $ZipPath ($Size MB)" -ForegroundColor Green
Write-Host "Send this single zip file to your friends."
