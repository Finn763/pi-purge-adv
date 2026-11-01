#!/usr/bin/env node
/**
 * 拉公开破甲题库到 .eval/banks/src/。
 *
 * 为什么不用 git clone / codeload：这台机器上 codeload.github.com 连不通，
 * 但 raw.githubusercontent.com 与 huggingface.co 的 raw 通道可用。
 *
 * 用法: node scripts/fetch-banks.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/paths.js";

const DEST = path.join(REPO_ROOT, ".eval", "banks", "src");

const SOURCES = [
  {
    name: "harmbench-text-all.csv",
    url: "https://raw.githubusercontent.com/centerforaisafety/HarmBench/main/data/behavior_datasets/harmbench_behaviors_text_all.csv",
  },
  {
    name: "strongreject-dataset.csv",
    url: "https://raw.githubusercontent.com/alexandrasouly/strongreject/main/strongreject_dataset/strongreject_dataset.csv",
  },
  {
    name: "strongreject-evaluator-prompt.txt",
    url: "https://raw.githubusercontent.com/alexandrasouly/strongreject/main/strongreject/strongreject_evaluator_prompt.txt",
  },
  {
    name: "safety-prompts-instruction-attack.json",
    url: "https://raw.githubusercontent.com/thu-coai/Safety-Prompts/main/instruction_attack_scenarios.json",
  },
  {
    name: "agentharm-harmful-test.json",
    url: "https://huggingface.co/datasets/ai-safety-institute/AgentHarm/raw/main/benchmark/harmful_behaviors_test_public.json",
  },
  {
    name: "agentharm-benign-test.json",
    url: "https://huggingface.co/datasets/ai-safety-institute/AgentHarm/raw/main/benchmark/benign_behaviors_test_public.json",
  },
  {
    name: "jbb-benign.csv",
    url: "https://huggingface.co/datasets/JailbreakBench/JBB-Behaviors/raw/main/data/benign-behaviors.csv",
  },
  {
    name: "jbb-harmful.csv",
    url: "https://huggingface.co/datasets/JailbreakBench/JBB-Behaviors/raw/main/data/harmful-behaviors.csv",
  },
];

async function download({ name, url }) {
  const target = path.join(DEST, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return { name, bytes: fs.statSync(target).size, cached: true };
  }
  const res = await fetch(url, { headers: { "User-Agent": "pi-purge-eval" } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  return { name, bytes: buf.length, cached: false };
}

fs.mkdirSync(DEST, { recursive: true });
const results = [];
for (const src of SOURCES) {
  try {
    const r = await download(src);
    results.push(r);
    console.log(`${r.cached ? "cache" : "get  "} ${r.name.padEnd(42)} ${(r.bytes / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.log(`FAIL  ${src.name.padEnd(42)} ${err.message}`);
  }
}
const ok = results.length;
console.log(`\n${ok}/${SOURCES.length} 个文件就位 → ${DEST}`);
