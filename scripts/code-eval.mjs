#!/usr/bin/env node
/**
 * 编码能力回归评测器：把 .eval/banks/code.jsonl 的每条题喂给 pi，抽 ``` 代码块，
 * 拼上断言用 node 真跑一遍，pass/fail 全机判，不靠判官模型。
 *
 * 与 eval-bank.mjs 的区别：那边判"有没有拒答"，这边判"代码跑不跑得对"。
 * RPC 客户端照抄 eval-bank.mjs 的 PiRpc（同样禁工具），只是多了抽代码 + 落盘执行。
 *
 * 用法：
 *   node scripts/code-eval.mjs --label code-off --mode off \
 *        --provider deepseek --model deepseek-v4-pro --cwd "$env:TEMP\pi-purge-adv-eval-cwd"
 *
 *   node scripts/code-eval.mjs --label code-on --mode force \
 *        --inject .eval/repo/prompts/deepseek-unrestricted-v3.md \
 *        --provider deepseek --model deepseek-v4-pro --cwd "$env:TEMP\pi-purge-adv-eval-cwd"
 *
 * 输出：
 *   .eval/results/<label>.jsonl          每行 {case_id, pass, reason, code, ms}
 *   .eval/results/<label>.summary.json   汇总（含按 topic 的通过率）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { detectPi } from "../src/core.js";
import { REPO_ROOT } from "../src/paths.js";

/* ---------------------------------------------------------------- 参数 */

function parseArgs(argv) {
  const out = {
    label: "code-run",
    bank: path.join(REPO_ROOT, ".eval", "banks", "code.jsonl"),
    mode: "",
    inject: "",
    cwd: "",
    provider: "deepseek",
    model: "",
    limit: 0,
    out: path.join(REPO_ROOT, ".eval", "results"),
    tmp: "",
    timeout: 180, // 单题等模型的时间（秒）
    testTimeout: 20, // 单题跑断言的时间（秒）
    thinking: "off",
    conc: 2,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--label") out.label = next();
    else if (a === "--bank") out.bank = next();
    else if (a === "--mode") out.mode = next();
    else if (a === "--inject") out.inject = next();
    else if (a === "--cwd") out.cwd = next();
    else if (a === "--provider") out.provider = next();
    else if (a === "--model") out.model = next();
    else if (a === "--limit") out.limit = Number(next());
    else if (a === "--out") out.out = next();
    else if (a === "--tmp") out.tmp = next();
    else if (a === "--timeout") out.timeout = Number(next());
    else if (a === "--test-timeout") out.testTimeout = Number(next());
    else if (a === "--thinking") out.thinking = next();
    else if (a === "--conc") out.conc = Math.max(1, Number(next()));
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

/* ---------------------------------------------------------------- 题库 */

function loadBank(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`${file}:${i + 1} JSON 解析失败: ${err.message}`);
      }
    });
}

/* ---------------------------------------------------------------- RPC 客户端（照抄 eval-bank.mjs） */

class PiRpc {
  constructor({ mode, inject, model, provider, thinking, cwd }) {
    const pi = detectPi();
    if (!pi.path) throw new Error("找不到 pi-coding-agent");
    this.cli = path.join(path.dirname(pi.path), "dist", "bundle", "cli.js");
    if (!fs.existsSync(this.cli)) throw new Error(`找不到 pi CLI: ${this.cli}`);
    const env = { ...process.env };
    if (mode) env.PI_PURGE_ADV_MODE = mode;
    if (inject) env.PI_PURGE_ADV_INJECT = path.resolve(inject);
    this.args = [this.cli, "--mode", "rpc"];
    if (provider) this.args.push("--provider", provider);
    if (model) this.args.push("--model", model);
    // 编码题必须闭卷：开着工具模型会去翻仓库/自己跑代码，判的就不是"写代码"了。
    this.args.push("--exclude-tools", "*");
    this.cwd = cwd ? path.resolve(cwd) : process.cwd();
    this.env = env;
    this.thinking = thinking;
    this.pending = new Map();
    this.seq = 0;
    this.stderr = "";
    this.exited = false;
    this.settleWaiter = null;
  }

  async start() {
    this.child = spawn(process.execPath, this.args, { env: this.env, cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (b) => {
      this.stderr += String(b);
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-10000);
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`pi 进程退出 code=${code}: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}`));
      }
      this.pending.clear();
      if (this.settleWaiter) this.settleWaiter();
    });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.startsWith("{")) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "agent_settled" || msg.type === "agent_end") {
        if (this.settleWaiter) {
          const done = this.settleWaiter;
          this.settleWaiter = null;
          done();
        }
        return;
      }
      if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    await new Promise((r) => setTimeout(r, 400));
    const state = await this.request({ type: "get_state" }, 90000);
    this.state = state?.data ?? null;
    // 模型 id 写错时 pi 只往 stderr 扔一句 warning 然后拿自定义 id 硬跑，
    // 结果照样出数、但跑的可能压根不是你以为的模型 —— 这里直接判死。
    if (/Model\s+"?[^"\s]+"?\s+not found for provider/i.test(this.stderr)) {
      throw new Error(`模型 id 无效，pi 用了自定义 id: ${this.stderr.trim().split("\n")[0]}`);
    }
    if (this.thinking) await this.request({ type: "set_thinking_level", level: this.thinking }, 15000).catch(() => {});
  }

  /** 实际解析到的模型，写进报告当证据。 */
  resolvedModel() {
    const m = this.state?.model;
    if (!m) return "(unknown)";
    return `${m.provider}/${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}`;
  }

  request(payload, timeout = 60000) {
    if (this.exited) {
      return Promise.reject(new Error(`pi 已退出: ${this.stderr.trim().split("\n").slice(-2).join(" | ")}`));
    }
    const id = `r${++this.seq}`;
    const body = JSON.stringify({ id, ...payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时: ${payload.type}${this.stderr ? ` | stderr: ${this.stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.child.stdin.write(body + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async ask(message, timeoutMs) {
    const settled = new Promise((resolve) => {
      this.settleWaiter = resolve;
    });
    const beforeMsgs = await this.request({ type: "get_messages" }, 30000).catch(() => null);
    const before = beforeMsgs?.data?.messages?.length ?? 0;
    await this.request({ type: "prompt", message }, 30000);
    await Promise.race([settled, new Promise((r) => setTimeout(r, timeoutMs))]);
    this.settleWaiter = null;
    await new Promise((r) => setTimeout(r, 300));
    const msgs = await this.request({ type: "get_messages" }, 30000);
    const list = msgs?.data?.messages ?? [];
    return list
      .slice(before)
      .filter((m) => m.role === "assistant")
      .map(assistantText)
      .filter(Boolean)
      .join("\n\n");
  }

  async newSession() {
    await this.request({ type: "new_session" }, 30000).catch(() => {});
  }

  stop() {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}

function assistantText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/* ---------------------------------------------------------------- 抽代码 */

/**
 * 取回答里第一个 ``` 围栏里的内容。
 * ```js\n<code>\n``` 和 ```js <code>``` 两种都要认；没有围栏时把整段回答当代码兜底，
 * 并标 from="raw"，方便报告里区分"没按格式输出"和"代码写错"。
 */
export function extractCode(text) {
  const s = String(text ?? "");
  const m = /```[ \t]*([a-zA-Z0-9_+.#-]*)[ \t]*\r?\n?([\s\S]*?)```/.exec(s);
  if (m) {
    const lang = (m[1] || "").toLowerCase();
    let code = m[2] ?? "";
    // 单行情形：```js const f = () => 1;``` → 第一个 token 被当成语言名了，补回去
    if (!code.trim() && lang) code = lang;
    return { code: code.trim(), lang, from: "fence" };
  }
  const raw = s.trim();
  if (raw) return { code: raw, lang: "", from: "raw" };
  return { code: "", lang: "", from: "none" };
}

/* ---------------------------------------------------------------- 跑断言 */

const PREAMBLE = `import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
`;

function runTestFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      out += String(b);
      if (out.length > 60000) out = out.slice(-30000);
    });
    child.stderr.on("data", (b) => {
      err += String(b);
      if (err.length > 60000) err = err.slice(-30000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn error: ${e.message}`, out, err });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        reason: killed ? "test timeout" : code === 0 ? "ok" : `exit ${code}${signal ? `/${signal}` : ""}`,
        out,
        err,
      });
    });
  });
}

/** 从 node 的报错里挑出行,压成一行方便写进 jsonl。 */
function compactReason({ reason, out, err }) {
  const text = String(err || out || "").replace(/\u001b\[[0-9;]*m/g, "");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const idx = lines.findIndex((l) => /^(AssertionError|TypeError|RangeError|SyntaxError|ReferenceError|Error)\b/.test(l));
  const picked = idx >= 0 ? lines.slice(idx, idx + 3) : lines.slice(0, 3);
  const body = picked.join(" | ").replace(/\s+/g, " ").slice(0, 300);
  return body ? `${reason}: ${body}` : reason;
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    return;
  }

  let cases = loadBank(opts.bank);
  if (opts.limit > 0) cases = cases.slice(0, opts.limit);
  if (!cases.length) throw new Error("题库为空");

  const tmpDir = opts.tmp || path.join(os.tmpdir(), "pi-code-eval", opts.label);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(opts.out, { recursive: true });

  const startedAt = new Date().toISOString();
  console.log(
    `[${opts.label}] ${cases.length} 条 · mode=${opts.mode || "(config)"} · model=${opts.model || "(default)"} · conc=${opts.conc}`,
  );
  if (opts.inject) console.log(`[${opts.label}] inject=${path.resolve(opts.inject)}`);

  const queue = cases.map((c, i) => ({ c, i }));
  const rows = new Array(cases.length);
  const resolvedModels = new Set();
  let done = 0;

  async function worker(id) {
    const rpc = new PiRpc(opts);
    await rpc.start();
    resolvedModels.add(rpc.resolvedModel());
    console.log(`[${opts.label}] 实际模型: ${rpc.resolvedModel()}`);
    try {
      while (queue.length) {
        const job = queue.shift();
        if (!job) break;
        const c = job.c;
        const t0 = Date.now();
        let response = "";
        let error = "";
        try {
          await rpc.newSession();
          response = await rpc.ask(c.prompt, opts.timeout * 1000);
        } catch (err) {
          error = String(err && err.message ? err.message : err);
        }

        const picked = extractCode(response);
        let pass = false;
        let reason = "";
        if (error) {
          reason = `model error: ${error}`.slice(0, 320);
        } else if (!picked.code) {
          reason = "no code block in response";
        } else {
          const file = path.join(tmpDir, `${c.case_id}.mjs`);
          fs.writeFileSync(file, `${PREAMBLE}\n// ---- model code (${picked.from}) ----\n${picked.code}\n\n// ---- test ----\n${c.test}\n`, "utf8");
          const run = await runTestFile(file, opts.testTimeout * 1000);
          pass = run.ok;
          reason = run.ok ? "ok" : compactReason(run);
          if (!run.ok && picked.from === "raw") reason = `no fence; ${reason}`;
        }

        const row = {
          case_id: c.case_id,
          pass,
          reason,
          code: picked.code,
          ms: Date.now() - t0,
          // 附加信号：pass 全绿时用它们看"输出形状"有没有退化
          //（围栏格式、代码行数、回答里代码之前的解释长度）
          fence: picked.from,
          code_lines: picked.code ? picked.code.split("\n").length : 0,
          response_chars: response.length,
          prose_chars: picked.from === "fence" ? Math.max(0, response.indexOf("```")) : 0,
        };
        rows[job.i] = row;
        done++;
        console.log(
          `${pass ? "PASS" : "FAIL"} ${c.case_id} (${row.ms}ms, ${picked.from}, ${picked.code.split("\n").length}行)${pass ? "" : ` — ${row.reason}`}`,
        );
      }
    } finally {
      rpc.stop();
    }
    void id;
  }

  const workers = Math.min(opts.conc, cases.length);
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));

  const finishedAt = new Date().toISOString();
  writeReports(opts, rows.filter(Boolean), { startedAt, finishedAt, resolvedModels: [...resolvedModels] });
}

function writeReports(opts, rows, { startedAt, finishedAt, resolvedModels = [] }) {
  const base = path.join(opts.out, opts.label);
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  fs.writeFileSync(`${base}.jsonl`, body, "utf8");

  const pass = rows.filter((r) => r.pass).length;
  const byTopic = {};
  const bank = loadBank(opts.bank);
  const topicOf = new Map(bank.map((c) => [c.case_id, c.topic || "misc"]));
  for (const r of rows) {
    const t = topicOf.get(r.case_id) || "misc";
    const s = (byTopic[t] ??= { total: 0, pass: 0 });
    s.total++;
    if (r.pass) s.pass++;
  }

  const summary = {
    label: opts.label,
    mode: opts.mode || "(config)",
    inject: opts.inject || "",
    provider: opts.provider || "(default)",
    model: opts.model || "(default)",
    resolvedModels,
    bank: path.relative(REPO_ROOT, path.resolve(opts.bank)).replace(/\\/g, "/"),
    total: rows.length,
    pass,
    fail: rows.length - pass,
    passRate: rows.length ? Math.round((pass / rows.length) * 1000) / 10 : 0,
    avgMs: rows.length ? Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length) : 0,
    byTopic,
    startedAt,
    finishedAt,
  };
  fs.writeFileSync(`${base}.summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(
    `\n[${opts.label}] 通过率 ${summary.passRate}% (${summary.pass}/${summary.total}) · 平均 ${summary.avgMs}ms · ${finishedAt}`,
  );
  for (const [t, v] of Object.entries(byTopic)) console.log(`  ${t}: ${v.pass}/${v.total}`);
  console.log(`输出: ${base}.jsonl / ${base}.summary.json`);
}

main().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
