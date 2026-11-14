#!/usr/bin/env bash
# run-ghidra.sh — 解包 Ghidra、对 vmde.exe 做全量分析、跑 VmReport.java 导出伪 C
#
# 前置：ghidra_v2.zip 已下载并通过 unzip -tq 校验（D:\hermes\cache\scratch\ghidra_v2.zip）
#       Ghidra 12.2 要求 JDK 25+（21 会被 launcher 拒绝）：C:\Program Files\Microsoft\jdk-25.0.5.21-hotspot
# 用法：bash tools/ghidra/run-ghidra.sh
set -u

SCRATCH=/d/hermes/cache/scratch
GHIDRA_HOME=/d/hermes/tools/ghidra
GHIDRA=/d/hermes/tools/ghidra/ghidra_12.2_PUBLIC
ZIP="$SCRATCH/ghidra_v2.zip"
TARGET="D:/Vector Magic/vmde.exe"
OUT="$SCRATCH/ghidra-out"
PROJ="$SCRATCH/ghidra-proj"

HEADLESS_BAT='D:\hermes\tools\ghidra\ghidra_12.2_PUBLIC\support\analyzeHeadless.bat'
JDK_WIN='C:\Program Files\Microsoft\jdk-25.0.5.21-hotspot'
JDK_UNIX="/c/Program Files/Microsoft/jdk-25.0.5.21-hotspot"
TARGET_WIN='D:\Vector Magic\vmde.exe'
OUT_WIN='D:\hermes\cache\scratch\ghidra-out'
PROJ_WIN='D:\hermes\cache\scratch\ghidra-proj'

export JAVA_HOME="$JDK_UNIX"
export PATH="$JAVA_HOME/bin:$PATH"
if [ ! -x "$JDK_UNIX/bin/java.exe" ]; then echo "找不到 JDK 25: $JDK_WIN"; exit 1; fi
echo "JAVA_HOME=$JAVA_HOME"

if [ ! -d "$GHIDRA_HOME" ]; then
  echo "解包 Ghidra…"
  mkdir -p "$GHIDRA_HOME"
  unzip -q -o "$ZIP" -d "$SCRATCH/ghidra_unzip" || { echo "解包失败"; exit 1; }
  inner="$(find "$SCRATCH/ghidra_unzip" -maxdepth 1 -type d -name 'ghidra_*' | head -1)"
  echo "inner=$inner"
  mv "$inner"/* "$GHIDRA_HOME"/ 2>/dev/null
fi

# Ghidra 解包后可能多一层目录（ghidra_12.2_PUBLIC/），直接搜
HEADLESS="$(find "$GHIDRA_HOME" -maxdepth 4 -name analyzeHeadless -type f 2>/dev/null | head -1)"
if [ -z "$HEADLESS" ]; then echo "找不到 analyzeHeadless"; exit 1; fi
chmod +x "$HEADLESS" 2>/dev/null
ECHO_HEADLESS="$HEADLESS"

mkdir -p "$OUT"
mkdir -p "$SCRATCH/ghidra-proj"          # analyzeHeadless 要求项目父目录已存在，否则直接 abort
export VM_REPORT_DIR="$OUT"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR_WIN="$(cygpath -w "$SCRIPT_DIR")"

echo "HEADLESS=$ECHO_HEADLESS"
echo "SCRIPT_DIR=$SCRIPT_DIR_WIN"
echo "开始分析（6.7MB x86 stripped，预计 15–30 分钟）…"
# 用 PowerShell 调 .bat：git-bash 里 `cmd //c` 会把参数吃掉，launcher 也找不到自己的 jar
powershell -NoProfile -Command "\$env:JAVA_HOME='${JDK_WIN}'; \$env:VM_REPORT_DIR='${OUT_WIN}'; & '${HEADLESS_BAT}' '${PROJ_WIN}' vmde -import '${TARGET_WIN}' -scriptPath '${SCRIPT_DIR_WIN}' -postScript VmReport.java -deleteProject" 2>&1 | tail -60

echo "=== 输出 ==="
ls -la "$OUT" | head -20
