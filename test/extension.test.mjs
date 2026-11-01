import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 用一个假 ExtensionAPI 驱动扩展本体，验证四个钩子在四种模式下的行为。
 * 不启动 pi、不调模型。
 */

function tmpEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-ext-"));
  const agent = path.join(root, "agent");
  const purge = path.join(agent, "pi-purge");
  fs.mkdirSync(purge, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_PURGE_DIR = purge;
  // 评测专用覆盖若从父进程泄漏进来，会把测试夹具的注入文本顶掉，这里显式清掉，保证测试密闭。
  delete process.env.PI_PURGE_INJECT;
  delete process.env.PI_PURGE_MODE;
  return { root, agent, purge };
}

function writeRuntime(purge, config, inject) {
  fs.writeFileSync(path.join(purge, "config.json"), JSON.stringify(config, null, 2), "utf8");
  fs.writeFileSync(path.join(purge, "prompt-inject.md"), inject, "utf8");
}

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    async fire(event, payload) {
      let current = payload;
      for (const handler of handlers.get(event) ?? []) {
        const result = await handler(current, { ui: { notify: () => {} } });
        if (result !== undefined) current = result;
      }
      return current;
    },
    commands,
  };
}

async function loadExtension(tag) {
  const url = new URL("../src/index.js", import.meta.url);
  url.search = `?tag=${tag}`;
  const mod = await import(url.href);
  return mod.default;
}

function baseOptions() {
  return {
    selectedTools: ["read", "bash"],
    hiddenTools: [],
    toolSnippets: { read: "Read a file", bash: "Run a command" },
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    cwd: process.cwd(),
    contextFiles: [],
    skills: [],
  };
}

const INJECT = '个人格：直接给答案。\n\n<!-- append -->\n- 中文输出';

test("section 模式改 systemPromptOptions，不整段替换", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "section" }, INJECT);
  const ext = await loadExtension("section");
  const pi = fakePi();
  ext(pi);

  const options = baseOptions();
  const event = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "ARMOR", systemPromptOptions: options };
  const result = await pi.fire("before_agent_start", event);

  assert.equal(result, event, "section 模式不返回新事件");
  assert.equal(options.customPrompt, "个人格：直接给答案。");
  assert.match(options.sections.tools, /- read: Read a file/);
  assert.match(options.sections.rules, /Answer the request directly/);
  assert.match(options.appendSystemPrompt, /中文输出/);
});

test("force 模式返回 systemPrompt 覆盖", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "force" }, INJECT);
  const ext = await loadExtension("force");
  const pi = fakePi();
  ext(pi);

  const options = baseOptions();
  const result = await pi.fire("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hi",
    systemPrompt: "ARMOR",
    systemPromptOptions: options,
  });

  assert.equal(typeof result.systemPrompt, "string");
  assert.match(result.systemPrompt, /个人格：直接给答案。/);
  assert.match(result.systemPrompt, /<tools>/);
  assert.doesNotMatch(result.systemPrompt, /ARMOR/);
});

test("payload 模式在 context_with_system 与 before_provider_request 两处都兜住", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "payload" }, INJECT);
  const ext = await loadExtension("payload");
  const pi = fakePi();
  ext(pi);

  await pi.fire("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hi",
    systemPrompt: "ARMOR",
    systemPromptOptions: baseOptions(),
  });

  const ctxResult = await pi.fire("context_with_system", {
    type: "context_with_system",
    messages: [
      { role: "system", content: "You are an expert coding assistant", timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ],
  });
  assert.match(ctxResult.messages[0].content, /个人格：直接给答案。/);
  assert.equal(ctxResult.messages[1].content, "hi");

  const payloadResult = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload: { model: "m", system: "You are an expert coding assistant", messages: [{ role: "user", content: "hi" }] },
  });
  assert.match(payloadResult.system, /个人格：直接给答案。/);
});

test("off 模式完全不动", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "off" }, INJECT);
  const ext = await loadExtension("off");
  const pi = fakePi();
  ext(pi);

  const options = baseOptions();
  const result = await pi.fire("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hi",
    systemPrompt: "ARMOR",
    systemPromptOptions: options,
  });
  assert.equal(result.systemPrompt, "ARMOR");
  assert.equal(options.customPrompt, undefined);
  assert.deepEqual(options.sections, {});

  const ctx = await pi.fire("context_with_system", {
    type: "context_with_system",
    messages: [{ role: "system", content: "ARMOR", timestamp: 1 }],
  });
  assert.equal(ctx.messages[0].content, "ARMOR");
});

test("soft 模式只追加，不换 preamble", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "soft" }, INJECT);
  const ext = await loadExtension("soft");
  const pi = fakePi();
  ext(pi);

  const options = baseOptions();
  await pi.fire("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hi",
    systemPrompt: "ARMOR",
    systemPromptOptions: options,
  });
  assert.equal(options.customPrompt, undefined);
  assert.match(options.appendSystemPrompt, /个人格/);
  assert.match(options.appendSystemPrompt, /中文输出/);
});

test("/purge mode 命令改配置并立即生效", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "section" }, INJECT);
  const ext = await loadExtension("command");
  const pi = fakePi();
  ext(pi);

  const cmd = pi.commands.get("purge");
  assert.ok(cmd, "注册了 /purge");
  await cmd.handler("mode payload", { ui: { notify: () => {} } });

  const cfg = JSON.parse(fs.readFileSync(path.join(purge, "config.json"), "utf8"));
  assert.equal(cfg.mode, "payload");
});

test("注入文本改完不用重启：下一次事件即生效", async () => {
  const { purge } = tmpEnv();
  writeRuntime(purge, { mode: "force" }, "旧人格");
  const ext = await loadExtension("hot");
  const pi = fakePi();
  ext(pi);

  const fire = () =>
    pi.fire("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: "hi",
      systemPrompt: "ARMOR",
      systemPromptOptions: baseOptions(),
    });

  const first = await fire();
  assert.match(first.systemPrompt, /旧人格/);

  fs.writeFileSync(path.join(purge, "prompt-inject.md"), "新人格", "utf8");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(purge, "prompt-inject.md"), future, future);

  const second = await fire();
  assert.match(second.systemPrompt, /新人格/);
});
