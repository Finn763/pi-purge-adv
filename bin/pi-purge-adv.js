#!/usr/bin/env node
/**
 * pi-purge-adv CLI
 *   pi-purge-adv status                看状态
 *   pi-purge-adv apply [--dry-run]     按 pi 包规范注册 + 打 settings 补丁
 *   pi-purge-adv apply --copy          改成复制式安装（<agent-dir>/extensions/pi-purge-adv）
 *   pi-purge-adv revert                还原 settings、摘包条目、删扩展副本
 *   pi-purge-adv uninstall --yes       连运行时目录一起删
 *   pi-purge-adv doctor                自检
 *   pi-purge-adv mode <m>              切模式 off|soft|section|force|payload
 *   pi-purge-adv path                  打印本包与运行时路径
 */
import process from "node:process";
import { apply, doctor, revert, status, uninstall } from "../src/core.js";
import { configPath, injectPath, purgeDir } from "../src/paths.js";
import { readConfig, writeConfig, MODES } from "../src/config.js";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const plain = argv.filter((a) => !a.startsWith("-"));

const mark = (ok) => (ok ? "✓" : "✗");

function printStatus() {
  const s = status();
  const lines = [];
  lines.push(`pi-purge-adv ${s.version} · 安装模式 ${s.installMode}`);
  lines.push(`· pi 版本      : ${s.pi.version || "未找到"} ${s.pi.path ? `(${s.pi.path})` : ""}`);
  lines.push(`· 包目录       : ${s.packageRoot}`);
  lines.push(`· 配置目录     : ${s.piAgentDir}`);
  lines.push(`· 运行时目录   : ${s.purgeDir}`);
  lines.push(`· 破甲模式     : ${s.mode}`);
  lines.push(`${mark(s.packageRegistered)} 包注册        : ${s.packageRegistered ? `settings.packages ← ${s.registerPath}` : "未注册"}`);
  lines.push(`${mark(s.extensionCopied)} 扩展副本      : ${s.extensionCopyDir}${s.extensionCopied ? "" : "（copy 模式才用）"}`);
  lines.push(`${mark(s.configExists && !s.configError)} 配置          : ${s.configFile}${s.configError ? ` — ${s.configError}` : ""}`);
  lines.push(`${mark(s.injectBytes > 0)} 注入文本      : ${s.injectFile} (${s.injectBytes}B)`);
  lines.push(`${mark(s.settingsExists && !s.settingsError)} settings      : ${s.settingsFile}${s.settingsError ? ` — ${s.settingsError}` : ""}`);
  lines.push(`· 备份         : ${s.backup || "无"}`);
  lines.push("settings 补丁:");
  for (const p of s.patches) {
    lines.push(`  ${mark(p.applied)} [${p.id}] ${p.label}`);
  }
  console.log(lines.join("\n"));
}

if (flags.has("-h") || flags.has("--help")) {
  console.log(`用法:
  pi-purge-adv status
  pi-purge-adv apply [--dry-run] [--copy]
  pi-purge-adv revert
  pi-purge-adv uninstall --yes
  pi-purge-adv doctor
  pi-purge-adv mode <${MODES.join("|")}>
  pi-purge-adv path

装法（两种，都走 pi 自己的约定）:
  apply          —— 把本包根目录写进 <agent-dir>/settings.json 的 packages，pi 就地加载
  apply --copy   —— 复制 src 下的扩展文件到 <agent-dir>/extensions/pi-purge-adv/

等价的官方命令: pi install <本包目录> / pi remove <本包目录>`);
  process.exit(0);
}

if (cmd === "status") {
  printStatus();
  process.exit(0);
}

if (cmd === "mode") {
  const want = String(plain[1] ?? "").toLowerCase();
  if (!MODES.includes(want)) {
    console.error(`模式必须是: ${MODES.join(" | ")}`);
    process.exit(2);
  }
  const { config } = readConfig();
  writeConfig({ ...config, mode: want });
  console.log(`pi-purge-adv 模式 → ${want}`);
  process.exit(0);
}

if (cmd === "path") {
  console.log(`包目录  : ${status().packageRoot}`);
  console.log(`注入文本: ${injectPath()}`);
  console.log(`配置    : ${configPath()}`);
  console.log(`运行时  : ${purgeDir()}`);
  process.exit(0);
}

if (cmd === "apply") {
  const dryRun = flags.has("--dry-run");
  const copy = flags.has("--copy");
  const report = apply(process.env, { dryRun, copy });
  if (dryRun) {
    console.log(`dry-run（${report.mode} 模式），没有写任何文件`);
    console.log(`· 会写: ${report.wouldWrite.join(", ")}`);
    console.log(`· 会建: ${report.wouldCreate.length ? report.wouldCreate.join(", ") : "无"}`);
    console.log(`· 会注册: ${report.willRegister ? "是" : "否（已注册）"}`);
    console.log(`· 会打补丁: ${report.patched.length ? report.patched.join(", ") : "无"}`);
    process.exit(0);
  }
  if (report.mode === "copy") {
    console.log(`扩展副本已写入: ${report.written.length ? report.written.join("\n                ") : "无变化"}`);
  } else {
    console.log(`包注册: ${report.registered ? `已写入 settings.packages ← ${status().registerPath}` : "已存在，未重复写"}`);
  }
  if (report.backup) console.log(`settings 备份: ${report.backup}${report.backupCreated ? "（新建）" : "（已存在，沿用原始件）"}`);
  console.log(`settings 补丁: ${report.patched.length ? report.patched.join(", ") : "无变化"}`);
  if (report.created.length) console.log(`运行时已初始化: ${report.created.join(", ")}`);
  console.log("新开一个 pi 会话（或 /reload）让扩展生效；提示词下一次运行即生效。");
  process.exit(0);
}

if (cmd === "revert") {
  const r = revert(process.env);
  const detail = r.restored
    ? "已用备份覆盖"
    : r.unregistered || r.patched.length
      ? `摘包条目 ${r.unregistered ? 1 : 0}、撤回补丁 ${r.patched.join(", ") || "0"}`
      : "无需还原";
  console.log(`settings 还原: ${detail}`);
  console.log(`扩展副本删除: ${r.removed.length ? r.removed.join(", ") : "无"}`);
  process.exit(0);
}

if (cmd === "uninstall") {
  if (!flags.has("--yes")) {
    console.error("会连运行时目录（config.json / prompt-inject.md / purge.log）一起删。确认请加 --yes");
    process.exit(2);
  }
  const r = uninstall(process.env);
  console.log(`已卸载。删除: ${r.removed.join(", ") || "无"}`);
  process.exit(0);
}

if (cmd === "doctor") {
  const d = doctor();
  for (const c of d.checks) console.log(`${mark(c.ok)} ${c.id.padEnd(16)} ${c.detail}`);
  console.log(d.ok ? "自检通过" : "自检有未通过项");
  process.exit(d.ok ? 0 : 1);
}

console.error(`未知命令: ${cmd}（用 --help 看用法）`);
process.exit(2);
