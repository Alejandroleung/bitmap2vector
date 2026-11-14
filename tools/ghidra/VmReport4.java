//@category VM
// VmReport4 — 追 t 参数化与 span 切分
//
// 目标地址（由 VmReport2/3 的结果推出）：
//   0x49c7b0 — 输入 span 的端点索引，返回 span 内的采样点数（决定用几次贝塞尔）
//   0x49ca70 — 紧随其后调用，疑似构造 t 数组
//   0x49aab0 / 0x49a970 / 0x49aee0 / 0x49a2f0 — 直线分支里用到的插值/构造
// 另外把 0x49e960 的所有调用者一起反编译（span 循环在那里）。

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.Reference;

import java.io.File;
import java.io.PrintWriter;
import java.util.LinkedHashSet;
import java.util.Set;

public class VmReport4 extends GhidraScript {

    private static final long[] DIRECT = {
        0x0049c7b0L, 0x0049ca70L, 0x0049aab0L, 0x0049a970L,
        0x0049aee0L, 0x0049a2f0L, 0x0049e960L, 0x0049d360L, 0x0049dcf0L
    };
    private static final long SPAN_DISPATCH = 0x0049e960L;

    @Override
    public void run() throws Exception {
        String outDir = System.getenv("VM_REPORT_DIR");
        if (outDir == null || outDir.isEmpty()) outDir = "D:/hermes/cache/scratch/ghidra-out4";
        File dir = new File(outDir);
        if (!dir.exists() && !dir.mkdirs()) { printerr("无法创建 " + outDir); return; }

        FunctionManager fm = currentProgram.getFunctionManager();
        Set<Function> targets = new LinkedHashSet<Function>();
        for (long a : DIRECT) {
            Function f = fm.getFunctionAt(toAddr(a));
            if (f == null) f = fm.getFunctionContaining(toAddr(a));
            if (f != null) targets.add(f); else println("未找到函数: " + Long.toHexString(a));
        }
        // span 调度的调用者
        for (Reference r : currentProgram.getReferenceManager().getReferencesTo(toAddr(SPAN_DISPATCH))) {
            Function f = fm.getFunctionContaining(r.getFromAddress());
            if (f != null) targets.add(f);
        }
        println("目标函数 " + targets.size() + " 个");

        DecompInterface dec = new DecompInterface();
        dec.toggleCCode(true);
        if (!dec.openProgram(currentProgram)) { printerr("反编译器打不开: " + dec.getLastMessage()); return; }

        PrintWriter csv = new PrintWriter(new File(dir, "tparam.csv"), "UTF-8");
        csv.println("addr,name,size,file");
        for (Function f : targets) {
            monitor.setMessage("反编译 " + f.getName());
            DecompileResults res = dec.decompileFunction(f, 120, monitor);
            String code = (res != null && res.decompileCompleted())
                    ? res.getDecompiledFunction().getC()
                    : "// 失败: " + (res == null ? "null" : res.getErrorMessage());
            String file = f.getEntryPoint() + "_" + f.getName().replaceAll("[^A-Za-z0-9_.-]", "_") + ".c";
            PrintWriter pw = new PrintWriter(new File(dir, file), "UTF-8");
            pw.println("// " + f.getName() + " @ " + f.getEntryPoint() + " size=" + f.getBody().getNumAddresses());
            pw.println(code);
            pw.close();
            csv.println(f.getEntryPoint() + "," + f.getName() + "," + f.getBody().getNumAddresses() + "," + file);
        }
        csv.close();
        dec.dispose();
        println("输出到 " + dir.getAbsolutePath());
    }
}
