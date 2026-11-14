#!/usr/bin/env bash
# run-ghidra2.sh — 第二轮：找 dgesv_ 调用点（VmReport2.java），项目保留以便后续追加查询
set -u

SCRATCH=/d/hermes/cache/scratch
HEADLESS_BAT='D:\hermes\tools\ghidra\ghidra_12.2_PUBLIC\support\analyzeHeadless.bat'
JDK_WIN='C:\Program Files\Microsoft\jdk-25.0.5.21-hotspot'
TARGET_WIN='D:\Vector Magic\vmde.exe'
OUT_WIN='D:\hermes\cache\scratch\ghidra-out2'
PROJ_WIN='D:\hermes\cache\scratch\ghidra-proj'
SCRIPT_DIR_WIN="$(cygpath -w "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"

mkdir -p "$OUT_WIN" "$SCRATCH/ghidra-proj"

echo "第二轮分析：导入 + 找 dgesv_ 调用点（项目保留）…"
powershell -NoProfile -Command "\$env:JAVA_HOME='${JDK_WIN}'; \$env:VM_REPORT_DIR='${OUT_WIN}'; & '${HEADLESS_BAT}' '${PROJ_WIN}' vmde -import '${TARGET_WIN}' -scriptPath '${SCRIPT_DIR_WIN}' -postScript VmReport2.java" 2>&1 | grep -E "命中|dgesv|输出|ERROR|INFO  VmReport2" | tail -40

echo "=== 输出 ==="
ls -la "$OUT_WIN" | head -20
