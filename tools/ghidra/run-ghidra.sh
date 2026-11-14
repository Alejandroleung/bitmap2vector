#!/usr/bin/env bash
# run-ghidra.sh — 解包 Ghidra、对 vmde.exe 做全量分析、跑 VmReport.java 导出伪 C
#
# 前置：ghidra_full.zip 已下载（D:\hermes\cache\scratch\ghidra_full.zip）
#       JDK 21 已装（C:\Program Files\Microsoft\jdk-21*）
# 用法：bash tools/ghidra/run-ghidra.sh
set -u

SCRATCH=/d/hermes/cache/scratch
GHIDRA_HOME=/d/hermes/tools/ghidra
ZIP="$SCRATCH/ghidra_full.zip"
TARGET="D:/Vector Magic/vmde.exe"
OUT="$SCRATCH/ghidra-out"
PROJ="$SCRATCH/ghidra-proj"

export JAVA_HOME="$(ls -d "/c/Program Files/Microsoft/"jdk-21* 2>/dev/null | head -1)"
if [ -z "${JAVA_HOME:-}" ]; then echo "找不到 JDK 21"; exit 1; fi
export PATH="$JAVA_HOME/bin:$PATH"
echo "JAVA_HOME=$JAVA_HOME"

if [ ! -d "$GHIDRA_HOME" ]; then
  echo "解包 Ghidra…"
  mkdir -p "$GHIDRA_HOME"
  unzip -q -o "$ZIP" -d "$SCRATCH/ghidra_unzip" || { echo "解包失败"; exit 1; }
  inner="$(find "$SCRATCH/ghidra_unzip" -maxdepth 1 -type d -name 'ghidra_*' | head -1)"
  echo "inner=$inner"
  mv "$inner"/* "$GHIDRA_HOME"/ 2>/dev/null
fi

HEADLESS="$GHIDRA_HOME/support/analyzeHeadless"
[ -x "$HEADLESS" ] || chmod +x "$HEADLESS" 2>/dev/null
if [ ! -f "$HEADLESS" ] && [ ! -f "$HEADLESS.bat" ]; then echo "找不到 analyzeHeadless"; exit 1; fi

mkdir -p "$OUT"
export VM_REPORT_DIR="$OUT"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "开始分析（6.7MB x86 stripped，预计 15–30 分钟）…"
"$HEADLESS" "$PROJ" vmde \
  -import "$TARGET" \
  -scriptPath "$SCRIPT_DIR" \
  -postScript VmReport.java \
  -deleteProject 2>&1 | tail -60

echo "=== 输出 ==="
ls -la "$OUT" | head -20
