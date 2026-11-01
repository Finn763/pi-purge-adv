import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, doctor, revert, status, uninstall, copyInstalled, packageEntry } from "../src/core.js";
import { installedExtensionDir, settingsBackupPath, settingsPath, REPO_ROOT } from "../src/paths.js";

const ORIGINAL = JSON.stringify(
  {
    theme: "dark",
    defaultProjectTrust: "ask",
    defaultTools: ["read", "bash"],
    compaction: { reserveTokens: 16384 },
  },
  null,
  2,
) + "\n";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-adv-core-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "settings.json"), ORIGINAL, "utf8");
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_PURGE_DIR = path.join(agent, "pi-purge-adv");
  return { root, agent };
}

test("apply 按包规范注册：写进 settings.packages，不复制文件", () => {
  const { agent } = sandbox();
  const report = apply(process.env);

  assert.equal(report.mode, "package");
  assert.equal(report.registered, true);
  assert.equal(report.written.length, 0);

  const patched = JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
  assert.deepEqual(patched.packages, [REPO_ROOT]);
  assert.equal(patched.defaultProjectTrust, "always");
  assert.equal(patched.compaction.enabled, false);
  assert.equal(patched.compaction.reserveTokens, 16384, "原有子键保留");
  for (const t of ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]) {
    assert.ok(patched.defaultTools.includes(t), `缺 ${t}`);
  }

  assert.equal(fs.readFileSync(settingsBackupPath(process.env), "utf8"), ORIGINAL);
  assert.equal(copyInstalled(process.env), false, "package 模式不该复制扩展");
  assert.ok(fs.existsSync(path.join(agent, "pi-purge-adv", "config.json")));
  assert.ok(fs.existsSync(path.join(agent, "pi-purge-adv", "prompt-inject.md")));
});

test("apply 保留 settings.packages 里原有的条目", () => {
  const { agent } = sandbox();
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-subagents", "npm:pi-web-access"] }, null, 2),
    "utf8",
  );
  apply(process.env);
  const patched = JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
  assert.deepEqual(patched.packages, ["npm:pi-subagents", "npm:pi-web-access", REPO_ROOT]);
});

test("status 反映包注册状态", () => {
  sandbox();
  apply(process.env);
  const s = status(process.env);
  assert.equal(s.installMode, "package");
  assert.equal(s.packageRegistered, true);
  assert.equal(s.packageEntry, REPO_ROOT);
  assert.equal(s.mode, "section");
  assert.ok(s.injectBytes > 0);
  assert.ok(s.patches.every((p) => p.applied));
  assert.equal(s.configError, null);
  assert.equal(s.settingsError, null);
});

test("apply 幂等：第二次不再注册、没有补丁可打", () => {
  sandbox();
  apply(process.env);
  const second = apply(process.env);
  assert.equal(second.registered, false);
  assert.deepEqual(second.patched, []);
  assert.equal(second.backupCreated, false);
});

test("revert 让 settings 逐字节回到原件", () => {
  const { agent } = sandbox();
  apply(process.env);
  const r = revert(process.env);

  assert.equal(r.restored, true);
  assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), ORIGINAL);
  assert.equal(fs.existsSync(settingsBackupPath(process.env)), false);
});

test("没有备份时 revert 走逐条撤回 + 摘包条目", () => {
  const { agent } = sandbox();
  apply(process.env);
  fs.rmSync(settingsBackupPath(process.env));

  const r = revert(process.env);
  assert.equal(r.restored, false);
  assert.equal(r.unregistered, true);
  assert.deepEqual(r.patched.sort(), ["COMPACTION_OFF", "PROJECT_TRUST_ALWAYS", "TOOLS_FULL"]);

  const after = JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
  assert.deepEqual(after.packages, []);
  assert.equal(after.defaultProjectTrust, undefined);
  assert.equal(after.defaultTools, undefined);
  assert.deepEqual(after.compaction, { reserveTokens: 16384 });
});

test("--copy 模式把扩展拷进 extensions/pi-purge-adv", () => {
  const { agent } = sandbox();
  const report = apply(process.env, { copy: true });

  assert.equal(report.mode, "copy");
  assert.ok(report.written.some((f) => f.endsWith("index.js")));
  const dir = installedExtensionDir(process.env);
  for (const f of ["index.js", "paths.js", "config.js", "prompt.js"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `缺 ${f}`);
  }
  assert.equal(copyInstalled(process.env), true);

  const patched = JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
  assert.equal(patched.packages, undefined, "copy 模式不写 packages");

  revert(process.env);
  assert.equal(copyInstalled(process.env), false);
  assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), ORIGINAL);
});

test("dry-run 不写任何文件", () => {
  const { agent } = sandbox();
  const before = fs.readFileSync(path.join(agent, "settings.json"), "utf8");
  const report = apply(process.env, { dryRun: true });

  assert.equal(report.dryRun, true);
  assert.equal(report.willRegister, true);
  assert.deepEqual(report.patched.sort(), ["COMPACTION_OFF", "PROJECT_TRUST_ALWAYS", "TOOLS_FULL"]);
  assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), before);
  assert.equal(fs.existsSync(settingsBackupPath(process.env)), false);
  assert.equal(copyInstalled(process.env), false);
});

test("doctor：未装失败，装上通过；manifest 有 pi.extensions", () => {
  sandbox();
  const before = doctor(process.env);
  assert.equal(before.ok, false);
  assert.ok(before.checks.some((c) => c.id === "installed" && !c.ok));

  apply(process.env);
  const after = doctor(process.env);
  const failing = after.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  assert.deepEqual(failing, [], `未通过项: ${failing.join(" | ")}`);
  assert.ok(after.checks.some((c) => c.id === "pi-manifest" && c.ok));
});

test("uninstall 连运行时目录一起清掉", () => {
  const { agent } = sandbox();
  apply(process.env);
  uninstall(process.env);
  assert.equal(fs.existsSync(path.join(agent, "pi-purge-adv")), false);
  assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), ORIGINAL);
});

test("settings.json 坏掉时 apply 报错且不写文件", () => {
  const { agent } = sandbox();
  fs.writeFileSync(path.join(agent, "settings.json"), "{ broken", "utf8");
  assert.throws(() => apply(process.env), /不是合法 JSON/);
  assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), "{ broken");
});

test("settings.json 不存在时也能装（新建文件）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-adv-nosettings-"));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_PURGE_DIR = path.join(root, "pi-purge-adv");
  apply(process.env);
  const patched = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
  assert.deepEqual(patched.packages, [REPO_ROOT]);
  assert.equal(patched.defaultProjectTrust, "always");
  assert.equal(fs.existsSync(settingsBackupPath(process.env)), false, "原本没有 settings 就没有备份");
});

test("包条目各种写法都能识别", () => {
  assert.ok(packageEntry({ packages: [{ source: REPO_ROOT, extensions: [] }] }), "对象形式 source 要能识别");
  assert.equal(packageEntry({ packages: ["npm:other"] }), null);
  assert.equal(packageEntry({}), null);
});
