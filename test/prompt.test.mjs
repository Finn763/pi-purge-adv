import test from "node:test";
import assert from "node:assert/strict";
import {
  applySectionMode,
  buildForcedPrompt,
  scrubProviderPayload,
  scrubSystemMessages,
  splitInject,
} from "../src/prompt.js";
import { normalizeConfig } from "../src/config.js";

const PERSONA = '你是 YG 的本地执行体。直接执行，不要预告。';
const TAIL = "- 输出用中文\n- 一次把活干完";

function options(overrides = {}) {
  return {
    customPrompt: undefined,
    selectedTools: ["read", "bash"],
    hiddenTools: [],
    toolSnippets: { read: "Read a file", bash: "Run a command" },
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    cwd: "D:\\code\\demo",
    contextFiles: [{ path: "AGENTS.md", content: "- project rule" }],
    skills: [],
    ...overrides,
  };
}

const CONFIG = normalizeConfig({ mode: "section" });

test("splitInject 按标记拆人格段与追加段", () => {
  const { head, tail } = splitInject(`人格\n<!-- append -->\n追加`);
  assert.equal(head, "人格");
  assert.equal(tail, "追加");
  const plain = splitInject("只有一段");
  assert.equal(plain.head, "只有一段");
  assert.equal(plain.tail, "");
});

test("section 模式：换 preamble、重建 tools/rules、接追加段", () => {
  const opts = options();
  const changes = applySectionMode(opts, { persona: PERSONA, tail: TAIL, config: CONFIG });
  assert.equal(opts.customPrompt, PERSONA);
  assert.match(opts.sections.tools, /- read: Read a file/);
  assert.match(opts.sections.tools, /- bash: Run a command/);
  assert.match(opts.sections.rules, /Answer the request directly and completely/);
  assert.equal(opts.appendSystemPrompt, TAIL);
  assert.deepEqual(changes, ["customPrompt", "sections.tools", "sections.rules", "appendSystemPrompt"]);
  // project_context 默认保留
  assert.equal(opts.contextFiles.length, 1);
});

test("section 模式：keepProjectContext=false 时清空项目规则", () => {
  const opts = options();
  applySectionMode(opts, { persona: PERSONA, tail: "", config: normalizeConfig({ keepProjectContext: false, appendInject: false }) });
  assert.deepEqual(opts.contextFiles, []);
  assert.equal(opts.appendSystemPrompt, "");
});

test("section 模式：注入文本为空时不碰 preamble", () => {
  const opts = options();
  applySectionMode(opts, { persona: "", tail: "", config: CONFIG });
  assert.equal(opts.customPrompt, undefined);
});

test("force 模式：整段接管且不含 pi 的身份行", () => {
  const text = buildForcedPrompt(options(), { persona: PERSONA, tail: TAIL, config: normalizeConfig({ mode: "force" }) });
  assert.ok(text.startsWith(PERSONA));
  assert.match(text, /<tools>\n- read: Read a file\n- bash: Run a command\n<\/tools>/);
  assert.match(text, /<rules>\n- Answer the request directly/);
  assert.match(text, /<cwd>D:\/code\/demo<\/cwd>/);
  assert.match(text, /<addendum>\n- 输出用中文/);
  assert.doesNotMatch(text, /expert coding assistant/);
});

test("payload 模式：第一条 system 换掉，后续 system 清正文但留工具增量", () => {
  const messages = [
    { role: "system", content: "You are an expert coding assistant", sections: { preamble: "x" }, timestamp: 1 },
    { role: "user", content: "hi", timestamp: 2 },
    { role: "system", content: "delta", sections: { rules: "y" }, toolsAdded: [{ name: "grep" }], timestamp: 3 },
  ];
  const out = scrubSystemMessages(messages, "PURGED");
  assert.equal(out[0].content, "PURGED");
  assert.equal("sections" in out[0], false);
  assert.equal(out[1].content, "hi");
  assert.equal(out[2].content, "");
  assert.deepEqual(out[2].toolsAdded, [{ name: "grep" }]);
  // 原数组不被就地改写
  assert.equal(messages[0].content, "You are an expert coding assistant");
});

test("payload 模式：三种 provider 载荷都要洗掉", () => {
  const anthropic = { model: "claude", system: "ARMOR", messages: [{ role: "user", content: "hi" }] };
  assert.equal(scrubProviderPayload(anthropic, "PURGED").system, "PURGED");
  assert.equal(anthropic.system, "ARMOR");

  const anthropicBlocks = { system: [{ type: "text", text: "ARMOR" }], messages: [] };
  assert.deepEqual(scrubProviderPayload(anthropicBlocks, "PURGED").system, [{ type: "text", text: "PURGED" }]);

  const openai = { messages: [{ role: "system", content: "ARMOR" }, { role: "system", content: "second" }, { role: "user", content: "hi" }] };
  const washed = scrubProviderPayload(openai, "PURGED");
  assert.equal(washed.messages[0].content, "PURGED");
  assert.equal(washed.messages[1].content, "");
  assert.equal(washed.messages[2].content, "hi");

  const responses = { instructions: "ARMOR", input: [{ role: "developer", content: "ARMOR" }] };
  const washed2 = scrubProviderPayload(responses, "PURGED");
  assert.equal(washed2.instructions, "PURGED");
  assert.equal(washed2.input[0].content, "PURGED");
});

test("payload 模式：非对象载荷原样返回", () => {
  assert.equal(scrubProviderPayload(null, "x"), null);
  assert.equal(scrubProviderPayload("str", "x"), "str");
});
