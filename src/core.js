/**
 * pi-purge-adv 引擎：注册 pi 包 / 复制式安装、settings 补丁、状态、回滚。
 *
 * 两种装法，都走 pi 自己的约定：
 *   package（默认）—— 把本包根目录写进 settings.packages。pi 认本地路径包，就地加载、
 *                     不复制；包更新（改代码）下次启动即生效。
 *   copy（--copy） —— 把 src 下的扩展文件拷进 <agent-dir>/extensions/pi-purge-adv/。
 *                     适合仓库会被挪走/删掉的场景。
 *
 * 任何写操作都可逆：settings 先备份，包条目可摘，扩展目录整份删除即还原。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  REPO_ROOT,
  configPath,
  injectPath,
  installedExtensionDir,
  personalExtensionsDir,
  piAgentDir,
  purgeDir,
  settingsBackupPath,
  settingsPath,
} from "./paths.js";
import { ensureRuntime, readConfig, readInject } from "./config.js";
import { applyPatches, patchStates, revertPatches } from "./settings.js";

/** copy 模式下需要搬进 extensions/pi-purge-adv/ 的运行时文件（index.js 用同名相对导入）。 */
const COPY_FILES = ["index.js", "paths.js", "config.js", "prompt.js", "retry.js", "compaction.js"];

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (err) {
    return { value: null, error: String(err && err.message ? err.message : err) };
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** settings.packages 的条目可能是字符串，也可能是 { source }。 */
export function entrySource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return "";
}

function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** settings.packages 里有没有本包。 */
export function packageEntry(settings, root = REPO_ROOT) {
  const list = Array.isArray(settings?.packages) ? settings.packages : [];
  const hit = list.find((entry) => samePath(entrySource(entry), root));
  return hit === undefined ? null : hit;
}

export function registerPackage(settings, root = REPO_ROOT) {
  if (packageEntry(settings, root)) return false;
  if (!Array.isArray(settings.packages)) settings.packages = [];
  settings.packages.push(root);
  return true;
}

export function unregisterPackage(settings, root = REPO_ROOT) {
  if (!Array.isArray(settings.packages)) return false;
  const next = settings.packages.filter((entry) => !samePath(entrySource(entry), root));
  if (next.length === settings.packages.length) return false;
  settings.packages = next;
  return true;
}

/** 找本机装的 pi-coding-agent 版本，不 spawn 进程。 */
export function detectPi(env = process.env) {
  const candidates = [];
  if (env.PI_CODING_AGENT_PKG) candidates.push(env.PI_CODING_AGENT_PKG);
  if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(path.join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  }
  candidates.push(
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    path.join("/usr", "local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    path.join("/usr", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  );
  for (const file of candidates) {
    const { value } = readJson(file);
    if (value && typeof value.version === "string") {
      return { version: value.version, path: file };
    }
  }
  return { version: "", path: "" };
}

/** 把扩展拷进 pi 的个人扩展目录，返回写入的文件。 */
export function installCopy(env = process.env) {
  const destRoot = installedExtensionDir(env);
  const written = [];
  for (const name of COPY_FILES) {
    const src = path.join(REPO_ROOT, "src", name);
    const dest = path.join(destRoot, name);
    if (!fs.existsSync(src)) throw new Error(`缺少运行时文件: ${src}`);
    const body = fs.readFileSync(src, "utf8");
    if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === body) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, "utf8");
    written.push(dest);
  }
  const pkgFile = path.join(destRoot, "package.json");
  const pkgBody = {
    name: "pi-purge-adv",
    version: readOwnManifest().version,
    private: true,
    type: "module",
    description: "pi 破甲扩展（pi-purge-adv apply --copy 安装，删掉本目录即还原）",
  };
  const next = JSON.stringify(pkgBody, null, 2) + "\n";
  const current = fs.existsSync(pkgFile) ? fs.readFileSync(pkgFile, "utf8") : "";
  if (current !== next) {
    fs.writeFileSync(pkgFile, next, "utf8");
    written.push(pkgFile);
  }
  return { dir: destRoot, written };
}

export function copyInstalled(env = process.env) {
  const dir = installedExtensionDir(env);
  return fs.existsSync(path.join(dir, "index.js")) && fs.existsSync(path.join(dir, "prompt.js"));
}

function readOwnManifest() {
  const { value } = readJson(path.join(REPO_ROOT, "package.json"));
  return value && typeof value === "object" ? value : {};
}

/** 备份 settings.json（只备份一次，保住最早的原始件）。 */
function backupSettings(env = process.env) {
  const file = settingsPath(env);
  const bak = settingsBackupPath(env);
  if (fs.existsSync(bak)) return { created: false, file: bak };
  if (!fs.existsSync(file)) return { created: false, file: "" };
  fs.copyFileSync(file, bak);
  return { created: true, file: bak };
}

function loadSettings(env) {
  const file = settingsPath(env);
  if (!fs.existsSync(file)) return { settings: {}, file, error: null, exists: false };
  const { value, error } = readJson(file);
  if (error) throw new Error(`settings.json 不是合法 JSON：${error}`);
  return { settings: value && typeof value === "object" ? value : {}, file, error: null, exists: true };
}

export function status(env = process.env) {
  const cfg = readConfig(env);
  const inject = readInject(env);
  const file = settingsPath(env);
  const { value, error } = fs.existsSync(file) ? readJson(file) : { value: {}, error: null };
  const settings = value ?? {};
  const registered = packageEntry(settings);
  const copied = copyInstalled(env);
  return {
    packageRoot: REPO_ROOT,
    piAgentDir: piAgentDir(env),
    purgeDir: purgeDir(env),
    settingsFile: file,
    settingsExists: fs.existsSync(file),
    settingsError: error,
    backup: fs.existsSync(settingsBackupPath(env)) ? settingsBackupPath(env) : "",
    registerPath: REPO_ROOT,
    packageRegistered: Boolean(registered),
    packageEntry: registered,
    extensionCopyDir: installedExtensionDir(env),
    extensionCopied: copied,
    extensionsRoot: personalExtensionsDir(env),
    installMode: registered ? "package" : copied ? "copy" : "none",
    configFile: configPath(env),
    config: cfg.config,
    configExists: cfg.exists,
    configError: cfg.error,
    injectFile: injectPath(env),
    injectBytes: inject.length,
    mode: cfg.config.mode,
    compaction: cfg.config.compaction,
    patches: patchStates(settings, { compaction: cfg.config.compaction }),
    pi: detectPi(env),
    version: readOwnManifest().version,
  };
}

export function apply(env = process.env, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const copy = Boolean(options.copy);
  const { settings, file } = loadSettings(env);
  const policy = { compaction: readConfig(env).config.compaction };

  const pendingPatches = patchStates(settings, policy).filter((p) => !p.applied).map((p) => p.id);
  const willRegister = copy ? !copyInstalled(env) : !packageEntry(settings);

  if (dryRun) {
    return {
      dryRun: true,
      mode: copy ? "copy" : "package",
      patched: pendingPatches,
      willRegister,
      wouldWrite: copy ? [installedExtensionDir(env)] : [REPO_ROOT],
      wouldCreate: [configPath(env), injectPath(env)].filter((p) => !fs.existsSync(p)),
      settings: file,
    };
  }

  const report = {
    dryRun: false,
    mode: copy ? "copy" : "package",
    created: [],
    written: [],
    patched: [],
    registered: false,
    backup: "",
    backupCreated: false,
    settings: file,
  };

  const bak = backupSettings(env);
  report.backup = bak.file;
  report.backupCreated = bak.created;

  if (copy) {
    report.written = installCopy(env).written;
  } else {
    report.registered = registerPackage(settings);
  }

  report.patched = applyPatches(settings, policy);
  if (report.registered || report.patched.length) writeJson(file, settings);

  report.created = ensureRuntime(env);
  return report;
}

export function revert(env = process.env) {
  const report = { restored: false, removed: [], patched: [], unregistered: false };
  const file = settingsPath(env);
  const bak = settingsBackupPath(env);

  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, file);
    fs.rmSync(bak, { force: true });
    report.restored = true;
  } else if (fs.existsSync(file)) {
    const { value } = readJson(file);
    if (value && typeof value === "object") {
      report.unregistered = unregisterPackage(value);
      report.patched = revertPatches(value);
      if (report.unregistered || report.patched.length) writeJson(file, value);
    }
  }

  const dir = installedExtensionDir(env);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    report.removed.push(dir);
  }
  return report;
}

export function uninstall(env = process.env) {
  const report = revert(env);
  const dir = purgeDir(env);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    report.removed.push(dir);
  }
  return report;
}

/** 自检：把「跑不跑得起来」的硬条件逐条判掉。 */
export function doctor(env = process.env) {
  const s = status(env);
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });

  push("package.json", Boolean(s.version), `${s.packageRoot} (v${s.version})`);
  push("pi-manifest", hasManifestField(), "package.json 的 pi.extensions");
  push("installed", s.installMode !== "none", `mode=${s.installMode}`);
  push("config", !s.configError, s.configError || s.configFile);
  push("inject", s.injectBytes > 0, `${s.injectFile} (${s.injectBytes}B)`);
  push("settings", s.settingsExists && !s.settingsError, s.settingsError || s.settingsFile);
  push("pi", Boolean(s.pi.version), s.pi.path || "未找到 pi-coding-agent");
  push("mode", s.mode !== "off", `mode=${s.mode}`);
  const pending = s.patches.filter((p) => !p.applied).map((p) => p.id);
  push("settings-patches", pending.length === 0, pending.length ? `待打: ${pending.join(", ")}` : "全部已打");
  push("backup", true, s.backup || "无备份（settings 没被改过就没备份，正常）");
  return { ok: checks.every((c) => c.ok), checks, status: s };
}

function hasManifestField() {
  const manifest = readOwnManifest();
  const list = manifest?.pi?.extensions;
  return Array.isArray(list) && list.length > 0;
}
