//@category VM
// VmReport2 — 找 dgesv_ 的真实调用点，并反编译调用者与其上一层
//
// 背景：Ghidra 把 dgesv_ 解析成一个 6 字节 thunk（jmp [IAT]），直接按符号取引用
// 只能找到 thunk 自己。这个脚本改为扫描全程序指令：
//   · CALL 指令的 flow 目标是 thunk 地址；或
//   · 指令操作数里引用了 IAT 槽（0x6fbc84）/ thunk 地址
// 命中函数 + 其直接调用者一起反编译。

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;

import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public class VmReport2 extends GhidraScript {

    @Override
    public void run() throws Exception {
        String outDir = System.getenv("VM_REPORT_DIR");
        if (outDir == null || outDir.isEmpty()) {
            outDir = "D:/hermes/cache/scratch/ghidra-out2";
        }
        File dir = new File(outDir);
        if (!dir.exists() && !dir.mkdirs()) {
            printerr("无法创建输出目录: " + outDir);
            return;
        }

        // ---- 收集 dgesv_ 相关的所有地址：符号地址、IAT 槽引用 ----
        Set<Address> seeds = new LinkedHashSet<Address>();
        SymbolTable st = currentProgram.getSymbolTable();
        SymbolIterator syms = st.getSymbols("dgesv_");
        while (syms.hasNext()) {
            Symbol sym = syms.next();
            seeds.add(sym.getAddress());
            println("符号 dgesv_ @ " + sym.getAddress());
            // 符号本身可能是个数据/指针，把它的引用也收进来
            for (Reference r : getReferencesTo(sym.getAddress())) {
                seeds.add(r.getFromAddress());
            }
        }
        // 直接从 PE 导入表扫一遍，找 IAT 槽
        int hits = 0;
        FunctionManager fm = currentProgram.getFunctionManager();
        Set<Function> callers = new LinkedHashSet<Function>();

        for (Function f : fm.getFunctions(true)) {
            if (monitor.isCancelled()) {
                break;
            }
            InstructionIterator ii = currentProgram.getListing().getInstructions(f.getBody(), true);
            while (ii.hasNext()) {
                Instruction ins = ii.next();
                boolean hit = false;
                for (Reference r : ins.getReferencesFrom()) {
                    Address to = r.getToAddress();
                    for (Address s : seeds) {
                        if (to.equals(s)) {
                            hit = true;
                        }
                    }
                    Symbol ts = currentProgram.getSymbolTable().getPrimarySymbol(to);
                    if (ts != null && "dgesv_".equals(ts.getName())) {
                        hit = true;
                    }
                }
                if (hit) {
                    callers.add(f);
                    println("命中 " + f.getName() + " @ " + f.getEntryPoint() + " : " + ins);
                    hits++;
                }
            }
        }
        println("dgesv_ 相关指令 " + hits + " 条，涉及函数 " + callers.size() + " 个");

        // ---- 加上一层调用者 ----
        Set<Function> all = new LinkedHashSet<Function>(callers);
        for (Function f : callers) {
            for (Function up : f.getCallingFunctions(monitor)) {
                all.add(up);
            }
        }

        DecompInterface dec = new DecompInterface();
        dec.toggleCCode(true);
        if (!dec.openProgram(currentProgram)) {
            printerr("反编译器打不开: " + dec.getLastMessage());
            return;
        }
        PrintWriter csv = new PrintWriter(new File(dir, "dgesv-site.csv"), "UTF-8");
        csv.println("addr,name,size,role,file");
        for (Function f : all) {
            monitor.setMessage("反编译 " + f.getName());
            DecompileResults res = dec.decompileFunction(f, 90, monitor);
            String code = (res != null && res.decompileCompleted())
                    ? res.getDecompiledFunction().getC()
                    : "// 失败: " + (res == null ? "null" : res.getErrorMessage());
            String role = callers.contains(f) ? "calls-dgesv" : "caller-of-caller";
            String file = f.getEntryPoint() + "_" + f.getName().replaceAll("[^A-Za-z0-9_.-]", "_") + ".c";
            PrintWriter pw = new PrintWriter(new File(dir, file), "UTF-8");
            pw.println("// " + f.getName() + " @ " + f.getEntryPoint() + " size=" + f.getBody().getNumAddresses() + " role=" + role);
            pw.println(code);
            pw.close();
            csv.println(f.getEntryPoint() + "," + f.getName() + "," + f.getBody().getNumAddresses() + "," + role + "," + file);
        }
        csv.close();
        dec.dispose();
        println("输出 " + all.size() + " 个函数到 " + dir.getAbsolutePath());
    }
}
