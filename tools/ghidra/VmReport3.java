//@category VM
// VmReport3 — 从曲线拟合函数往上走，找分段/平滑阶段的驱动函数
//
// 种子：0049dcf0（二次贝塞尔拟合）、0049d360（三次贝塞尔拟合）、005bbd40（自研 GEMM）
// 做法：沿调用者链向上爬 3 层全部反编译；另外把调用同一 GEMM 的函数也拉出来，
//       它们就是同一个矩阵库的使用者（拟合/平滑/分割都在其中）。
// 用法：对已分析过的项目用 -process（不需要重新分析）。

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

public class VmReport3 extends GhidraScript {

    private static final long[] SEEDS = { 0x0049dcf0L, 0x0049d360L, 0x005bbd40L };
    private static final int DEPTH = 3;

    @Override
    public void run() throws Exception {
        String outDir = System.getenv("VM_REPORT_DIR");
        if (outDir == null || outDir.isEmpty()) outDir = "D:/hermes/cache/scratch/ghidra-out3";
        File dir = new File(outDir);
        if (!dir.exists() && !dir.mkdirs()) { printerr("无法创建 " + outDir); return; }

        FunctionManager fm = currentProgram.getFunctionManager();
        ReferenceManager rm = currentProgram.getReferenceManager();
        Map<Function, Integer> level = new HashMap<Function, Integer>();
        Deque<Function> queue = new ArrayDeque<Function>();

        for (long s : SEEDS) {
            Address a = toAddr(s);
            Function f = fm.getFunctionAt(a);
            if (f == null) f = fm.getFunctionContaining(a);
            if (f != null) { level.put(f, 0); queue.add(f); println("种子 " + f.getName() + " @ " + f.getEntryPoint()); }
        }

        // 同时把"调用 GEMM 的函数"收进来：它们共用同一个矩阵库
        Address gemm = toAddr(0x005bbd40L);
        for (Reference r : rm.getReferencesTo(gemm)) {
            Function f = fm.getFunctionContaining(r.getFromAddress());
            if (f != null && !level.containsKey(f)) { level.put(f, 1); queue.add(f); }
        }

        while (!queue.isEmpty()) {
            Function f = queue.poll();
            int lv = level.get(f);
            if (lv >= DEPTH) continue;
            for (Function up : f.getCallingFunctions(monitor)) {
                if (!level.containsKey(up)) { level.put(up, lv + 1); queue.add(up); }
            }
        }
        println("共 " + level.size() + " 个相关函数（含 " + DEPTH + " 层调用者）");

        DecompInterface dec = new DecompInterface();
        dec.toggleCCode(true);
        if (!dec.openProgram(currentProgram)) { printerr("反编译器打不开: " + dec.getLastMessage()); return; }

        PrintWriter csv = new PrintWriter(new File(dir, "callers.csv"), "UTF-8");
        csv.println("addr,name,size,depth,callees_window,file");
        int n = 0;
        for (Map.Entry<Function, Integer> e : level.entrySet()) {
            Function f = e.getKey();
            monitor.setMessage("反编译 " + f.getName());
            DecompileResults res = dec.decompileFunction(f, 90, monitor);
            String code = (res != null && res.decompileCompleted())
                    ? res.getDecompiledFunction().getC()
                    : "// 失败: " + (res == null ? "null" : res.getErrorMessage());
            // 粗统计：函数体里出现多少次浮点运算/调用，便于快速排序哪些是数学函数
            int flops = 0;
            for (String op : new String[]{"fVar", "* _DAT", "double"}) {
                int idx = 0;
                while ((idx = code.indexOf(op, idx)) >= 0) { flops++; idx += op.length(); }
            }
            String file = f.getEntryPoint() + "_" + f.getName().replaceAll("[^A-Za-z0-9_.-]", "_") + ".c";
            PrintWriter pw = new PrintWriter(new File(dir, file), "UTF-8");
            pw.println("// " + f.getName() + " @ " + f.getEntryPoint() + " size=" + f.getBody().getNumAddresses()
                    + " depth=" + e.getValue() + " floatHits=" + flops);
            pw.println(code);
            pw.close();
            csv.println(f.getEntryPoint() + "," + f.getName() + "," + f.getBody().getNumAddresses() + ","
                    + e.getValue() + "," + flops + "," + file);
            n++;
        }
        csv.close();
        dec.dispose();
        println("输出 " + n + " 个函数到 " + dir.getAbsolutePath());
    }
}
