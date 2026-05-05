# 친구 배포 ZIP 패키지 생성
# 사용: pwsh scripts/build-distribute.ps1  또는  npm run dist
#
# 전제: 'npm run build' 후 dist/LineageMPTimer-<version>-portable.exe 존재
# 산출: dist/LineageMPTimer-v<version>.zip  (포터블 exe + 사용설명서 + 처음시작 + 변경내역)

param(
  [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# 버전 자동 감지 (package.json)
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
  Write-Error "Portable exe 없음: $Portable`n먼저 'npm run build' 실행하세요."
  exit 1
}

Write-Host "📦 친구 배포 패키지 생성 시작 — v$Version"

# 기존 패키지 정리
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
if (Test-Path $ZipPath)    { Remove-Item -Force $ZipPath }
New-Item -ItemType Directory -Path $StagingDir | Out-Null

# 1) 포터블 exe 복사
Copy-Item $Portable -Destination (Join-Path $StagingDir "LineageMPTimer-$Version-portable.exe")
Write-Host "  ✓ 포터블 exe 복사"

# 2) 사용설명서 복사 (있으면)
$ManualSrc = Join-Path $Root '사용설명서.md'
if (Test-Path $ManualSrc) {
  Copy-Item $ManualSrc -Destination (Join-Path $StagingDir '사용설명서.md')
  Write-Host "  ✓ 사용설명서.md 복사"
}

# 3) 처음시작.txt
$QuickStart = @"
🎮 리니지 MP 타이머 v$Version — 처음 시작 (1분)

1️⃣ "LineageMPTimer-$Version-portable.exe" 더블클릭
   ⚠️ Windows Defender 경고가 뜨면 "추가 정보" → "실행" 클릭
       (개인 빌드라 서명 X — 안전합니다)

2️⃣ "OCR·아이템" 탭 → "자동 모드 (NEW)" 선택
   → "🎮 게임 화면 영역 지정" 버튼 한 번만 드래그
   → MP / 경험치 / 레벨 / 아데나 위치 자동 탐지

3️⃣ "메인" 탭에서 MP 게이지 + 카운트다운 자동 동작

자세한 사용법은 "사용설명서.md" 참고
즐거운 사냥하세요! 🗡️
"@
$QuickStart | Out-File -FilePath (Join-Path $StagingDir '처음시작.txt') -Encoding UTF8
Write-Host "  ✓ 처음시작.txt 생성"

# 4) 변경내역.txt
$Changelog = @"
LineageMPTimer v$Version — 변경내역

⭐ 새로운 기능 — 자동 ROI 탐지 (v1.4.0)
- 게임 화면 영역 1개만 드래그 → MP/경험치/레벨/아데나 위치 자동 탐지
- 셋업 시간 5분 → 1분
- HSV 색상 분석으로 HP 바 / MP 바 / EXP 바 / 아데나 아이콘 자동 인식
- 게임 창 이동에 더 강함

🛡️ OCR 안정화 (v1.3.22 안전망 통합)
- 자릿수 misread (예: "88" → "8" 1자리 인식) 영원 폐기 → 20회 일관 검증 흡수
  → 사용자 직접 입력 없이도 anchor 자동 회복 가능
- 영역 너무 좁게 (height < 18px) 지정 시 친절한 경고
- 다중 캔버스 OCR ensemble (최대 18 results 다수결) 유지
- 휘도 mode white extraction (베이지 글자 대응) 유지
- 멀티 모니터 displayId 일치 검증 유지

🎨 UX/UI 개선
- 자동 모드 기본 추천, 수동 모드는 고급/fallback
- 자동 모드 첫 선택 시 3단계 온보딩 안내
- ROI 탐지 실패 시 단계별 가이드

이전 수동 모드도 그대로 사용 가능 — 자동/수동 토글로 즉시 전환
"@
$Changelog | Out-File -FilePath (Join-Path $StagingDir '변경내역.txt') -Encoding UTF8
Write-Host "  ✓ 변경내역.txt 생성"

# 5) ZIP 압축
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($StagingDir, $ZipPath)
Write-Host "  ✓ ZIP 압축"

# 6) staging 정리
Remove-Item -Recurse -Force $StagingDir

$Size = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)
Write-Host ""
Write-Host "✅ 패키지 생성 완료" -ForegroundColor Green
Write-Host "   $ZipPath" -ForegroundColor Cyan
Write-Host "   크기: $Size MB"
Write-Host ""
Write-Host "친구에게 위 ZIP 파일 1개만 전달하면 됩니다."
