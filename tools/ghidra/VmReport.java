//@category VM
// VmReport — 把 Vector Magic 的算法面从 vmde.exe 里挖出来
//
// 做三件事：
//   1. 按 vm-binary-symbols.md 里那些设置/流水线签名字符串，找出引用它们的函数；
//   2. 找 dgesv_ 的全部调用点（唯一导入的 LAPACK 例程 → 线性求解发生在哪）；
//   3. 把这些函数逐个反编译成伪 C，落盘 + 一张索引 CSV。
//
// 用法（analyzeHeadless）：
//   analyzeHeadless.bat <projDir> vmde -import "D:\Vector Magic\vmde.exe" \
//       -scriptPath tools\ghidra -postScript VmReport.java [-noanalysis] -deleteProject
// 输出目录由环境变量 VM_REPORT_DIR 指定。

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;

import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class VmReport extends GhidraScript {

    private static final String[] NEEDLES = {
        // 高级设置（算法参数面）
        "setAdvSegmentationComplexity", "setAdvMinNumPixels", "setAdvAntiAliasingRejection",
        "setAdvClusterColors", "setAdvColorSensitivity", "setAdvNumColors",
        "setAdvContourSmoothness", "setAdvCurveComplexity", "setAdvDetectSharpCorners",
        "setAdvUseContourAa", "setAdvUsePaletteAa",
        "setAdvancedModeSettings", "AdvVectorizationSettings", "VmVectorizationSettings",
        "VmPaletteModeType", "FlattenImageModeType",
        // 流水线阶段
        "aboutToStartTask", "prepareForTask", "completedTask", "ThreadTaskType",
        // 导出
        "setCakeStackMode", "setShapeStrokingMode", "setDxfMode", "setEpsCompatibilityMode",
        // 任务/入口
        "vectorizeImageWithMruSettings",
        // 观感线索
        "Smoothing Result", "Segmentation", "Palette"
    };

    @Override
    public void run() throws Exception {
        String outDir = System.getenv("VM_REPORT_DIR");
        if (outDir == null || outDir.isEmpty()) {
            outDir = "D:/hermes/cache/scratch/ghidra-out";
        }
        File dir = new File(outDir);
        if (!dir.exists() && !dir.mkdirs()) {
            printerr("无法创建输出目录: " + outDir);
            return;
        }

        Program program = currentProgram;
        Listing listing = program.getListing();

        // ---------- 1. 字符串引用 → 函数 ----------
        Map<Function, Set<String>> byFunction = new LinkedHashMap<Function, Set<String>>();
        DataIterator dataIt = listing.getDefinedData(true);
        int scanned = 0;
        while (dataIt.hasNext() && !monitor.isCancelled()) {
            Data d = dataIt.next();
            if (d == null) {
                continue;
            }
            Object value = d.getValue();
            if (!(value instanceof String)) {
                continue;
            }
            String s = (String) value;
            scanned++;
            for (String needle : NEEDLES) {
                if (s.contains(needle)) {
                    Reference[] refs = getReferencesTo(d.getAddress());
                    for (Reference r : refs) {
                        Function f = listing.getFunctionContaining(r.getFromAddress());
                        if (f != null) {
                            Set<String> bag = byFunction.get(f);
                            if (bag == null) {
                                bag = new LinkedHashSet<String>();
                                byFunction.put(f, bag);
                            }
                            bag.add(needle);
                        }
                    }
                    break;
                }
            }
        }
        println("扫描字符串 " + scanned + " 条，命中函数 " + byFunction.size() + " 个");

        // ---------- 2. dgesv_ 调用点 ----------
        Set<Function> lapackCallers = new LinkedHashSet<Function>();
        SymbolTable st = program.getSymbolTable();
        SymbolIterator syms = st.getSymbols("dgesv_");
        List<Address> targets = new ArrayList<Address>();
        while (syms.hasNext()) {
            Symbol sym = syms.next();
            targets.add(sym.getAddress());
            println("找到符号 dgesv_ @ " + sym.getAddress());
        }
        for (Address a : targets) {
            Reference[] refs = getReferencesTo(a);
            for (Reference r : refs) {
                Function f = listing.getFunctionContaining(r.getFromAddress());
                if (f != null) {
                    lapackCallers.add(f);
                }
            }
        }
        println("dgesv_ 调用者函数: " + lapackCallers.size());

        // ---------- 3. 反编译 + 落盘 ----------
        DecompInterface dec = new DecompInterface();
        dec.toggleCCode(true);
        dec.toggleSyntaxTree(true);
        if (!dec.openProgram(program)) {
            printerr("反编译器打不开程序: " + dec.getLastMessage());
            return;
        }

        PrintWriter csv = new PrintWriter(new File(dir, "index.csv"), "UTF-8");
        csv.println("addr,name,size,strings,lapack_caller,file");

        Set<Function> all = new LinkedHashSet<Function>(byFunction.keySet());
        all.addAll(lapackCallers);

        int n = 0;
        for (Function f : all) {
            if (monitor.isCancelled()) {
                break;
            }
            monitor.setMessage("反编译 " + f.getName());
            DecompileResults res = dec.decompileFunction(f, 60, monitor);
            String code = (res != null && res.decompileCompleted())
                    ? res.getDecompiledFunction().getC()
                    : "// 反编译失败: " + (res == null ? "null" : res.getErrorMessage());
            Set<String> strs = byFunction.get(f);
            StringBuilder sb = new StringBuilder();
            if (strs != null) {
                for (String s : strs) {
                    if (sb.length() > 0) {
                        sb.append(" | ");
                    }
                    sb.append(s);
                }
            }
            String fileName = String.format("%s_%s.c", f.getEntryPoint(), sanitize(f.getName()));
            PrintWriter pw = new PrintWriter(new File(dir, fileName), "UTF-8");
            pw.println("// " + f.getName() + " @ " + f.getEntryPoint()
                    + "  size=" + f.getBody().getNumAddresses()
                    + "  strings=" + sb);
            if (lapackCallers.contains(f)) {
                pw.println("// dgesv_ 调用者");
            }
            pw.println(code);
            pw.close();
            csv.println(f.getEntryPoint() + "," + f.getName() + "," + f.getBody().getNumAddresses()
                    + ",\"" + sb + "\"," + (lapackCallers.contains(f) ? 1 : 0) + "," + fileName);
            n++;
        }
        csv.close();
        dec.dispose();
        println("已输出 " + n + " 个函数的伪 C 到 " + dir.getAbsolutePath());
    }

    private String sanitize(String s) {
        return s.replaceAll("[^A-Za-z0-9_.-]", "_");
    }
}
