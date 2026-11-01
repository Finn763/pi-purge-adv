/**
 * 路径解析：全部跟随 pi 自己的约定，不写死盘符。
 *
 * PI_CODING_AGENT_DIR 是 pi 官方认的配置目录覆盖（默认 ~/.pi/agent）。
 * PI_PURGE_DIR 只覆盖本工具自己的运行时目录，便于测试与多份安装。
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * 环境变量读取：新前缀 PI_PURGE_ADV_*，兼容旧前缀 PI_PURGE_*（老脚本/老配置不用改）。
 */
export function envVar(name, env = process.env) {
  const next = env[`PI_PURGE_ADV_${name}`];
  if (next !== undefined) return next;
  return env[`PI_PURGE_${name}`] ?? "";
}

/** pi 的配置目录（agent dir）。 */
export function piAgentDir(env = process.env) {
  const override = expandHome(env.PI_CODING_AGENT_DIR || "");
  return override || path.join(os.homedir(), ".pi", "agent");
}

/** 本工具的运行时目录：config.json / prompt-inject.md / purge.log。 */
export function purgeDir(env = process.env) {
  const override = expandHome(envVar("DIR", env) || "");
  return override || path.join(piAgentDir(env), "pi-purge-adv");
}

export function configPath(env = process.env) {
  return path.join(purgeDir(env), "config.json");
}

export function injectPath(env = process.env) {
  return path.join(purgeDir(env), "prompt-inject.md");
}

export function logPath(env = process.env) {
  return path.join(purgeDir(env), "purge.log");
}

/** pi 的个人扩展目录：放进去即自动加载，不需要改 settings。 */
export function personalExtensionsDir(env = process.env) {
  return path.join(piAgentDir(env), "extensions");
}

/** copy 模式的安装位置。 */
export function installedExtensionDir(env = process.env) {
  return path.join(personalExtensionsDir(env), "pi-purge-adv");
}

export function settingsPath(env = process.env) {
  return path.join(piAgentDir(env), "settings.json");
}

export function settingsBackupPath(env = process.env) {
  return `${settingsPath(env)}.pipurge.bak`;
}

/** 本包根目录（package.json 所在处）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
