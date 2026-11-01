import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig, readConfig, readInject, ensureRuntime, stripBom } from "../src/config.js";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-adv-cfg-"));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_PURGE_DIR = path.join(process.env.PI_CODING_AGENT_DIR, "pi-purge-adv");
  fs.mkdirSync(process.env.PI_PURGE_DIR, { recursive: true });
  return process.env.PI_PURGE_DIR;
}

test("带 BOM 的 config.json 照样解析（记事本存盘会带 BOM）", () => {
  const purge = sandbox();
  fs.writeFileSync(path.join(purge, "config.json"), "\uFEFF" + JSON.stringify({ mode: "payload" }), "utf8");
  const { config, error } = readConfig();
  assert.equal(error, null);
  assert.equal(config.mode, "payload");
});

test("带 BOM 的注入文本不会被当成正文首字符", () => {
  const purge = sandbox();
  fs.writeFileSync(path.join(purge, "prompt-inject.md"), "\uFEFF人格", "utf8");
  assert.equal(readInject(), "人格");
  assert.equal(stripBom("\uFEFFx"), "x");
});

test("非法 mode 回落默认，guidelines 过滤空项", () => {
  const cfg = normalizeConfig({ mode: "ultra", guidelines: ["  a  ", "", null, "b"] });
  assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
  assert.deepEqual(cfg.guidelines, ["a", "b"]);
});

test("config.json 坏掉不抛异常，回落到默认值并给出 error", () => {
  const purge = sandbox();
  fs.writeFileSync(path.join(purge, "config.json"), "{ nope", "utf8");
  const { config, error } = readConfig();
  assert.equal(config.mode, DEFAULT_CONFIG.mode);
  assert.match(error, /JSON|Unexpected|Expected/);
});

test("ensureRuntime 只补缺的文件", () => {
  const purge = sandbox();
  const created = ensureRuntime();
  assert.equal(created.length, 2);
  assert.equal(ensureRuntime().length, 0);
  assert.ok(fs.existsSync(path.join(purge, "config.json")));
  assert.match(readInject(), /YG/);
});
