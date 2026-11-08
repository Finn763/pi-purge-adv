import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPACTION_POLICIES,
  GUARD_INSTRUCTIONS,
  frameBlock,
  guardCompaction,
  mergeInstructions,
  mergeSummary,
  normalizeCompactionPolicy,
} from "../src/compaction.js";

test("策略只认 guard/on/off，其它回落 guard", () => {
  assert.deepEqual(COMPACTION_POLICIES, ["guard", "on", "off"]);
  assert.equal(normalizeCompactionPolicy("guard"), "guard");
  assert.equal(normalizeCompactionPolicy("OFF"), "off");
  assert.equal(normalizeCompactionPolicy(" on "), "on");
  assert.equal(normalizeCompactionPolicy(""), "guard");
  assert.equal(normalizeCompactionPolicy(undefined), "guard");
  assert.equal(normalizeCompactionPolicy("force"), "guard");
});

test("续接块带模式与人格首行", () => {
  const frame = frameBlock({ mode: "force", persona: "\n你是 YG 的本地执行体。\n第二行不要" });
  assert.match(frame, /^\[pi-purge-adv · 续接块\]/);
  assert.match(frame, /当前模式：force/);
  assert.match(frame, /首行：你是 YG 的本地执行体。/);
  assert.ok(!frame.includes("第二行不要"), "只取首行");
  assert.match(frame, /不代表当前立场/);

  const bare = frameBlock({ mode: "section" });
  assert.match(bare, /当前模式：section/);
  assert.ok(!bare.includes("首行"), "没有人格就不写首行");
});

test("摘要尾部拼续接块；重复压缩时替换旧的块，不叠第二份", () => {
  const frame = frameBlock({ mode: "section" });
  const once = mergeSummary("历史摘要正文", frame);
  assert.ok(once.startsWith("历史摘要正文"));
  assert.equal(once.split("[pi-purge-adv · 续接块]").length, 2);

  const twice = mergeSummary(once, frameBlock({ mode: "force" }));
  assert.equal(twice.split("[pi-purge-adv · 续接块]").length, 2, "只留一份");
  assert.match(twice, /当前模式：force/, "取最新的模式");
  assert.ok(twice.startsWith("历史摘要正文"));

  assert.equal(mergeSummary("", frame), frame);
  assert.equal(mergeSummary("只有摘要", ""), "只有摘要");
});

test("用户自己的 /compact 指令保留，守卫指令追加在后面", () => {
  const merged = mergeInstructions("focus on the failing test");
  assert.ok(merged.startsWith("focus on the failing test"));
  assert.ok(merged.includes(GUARD_INSTRUCTIONS));
  assert.equal(mergeInstructions(""), GUARD_INSTRUCTIONS);
  assert.equal(mergeInstructions(undefined), GUARD_INSTRUCTIONS);
});

function fakeCtx(overrides = {}) {
  return { model: { id: "deepseek-flash" }, thinkingLevel: "high", ...overrides };
}

test("guardCompaction 用 pi 的 compact 生成摘要并追加续接块", async () => {
  const calls = [];
  const compact = async (...args) => {
    calls.push(args);
    return { summary: "摘要正文", firstKeptEntryId: "e7", tokensBefore: 90000, usage: { totalTokens: 1234 } };
  };
  const event = {
    preparation: { firstKeptEntryId: "e7", tokensBefore: 90000, messagesToSummarize: [] },
    reason: "threshold",
    customInstructions: "",
    signal: new AbortController().signal,
  };

  const out = await guardCompaction({
    event,
    ctx: fakeCtx(),
    compact,
    auth: { apiKey: "k-123", headers: { "x-test": "1" } },
    frame: frameBlock({ mode: "section", persona: "你是 YG 的本地执行体。" }),
  });

  assert.ok(out?.compaction, "要把自定义结果返回给 pi");
  assert.match(out.compaction.summary, /摘要正文/);
  assert.match(out.compaction.summary, /续接块/);
  assert.equal(out.compaction.firstKeptEntryId, "e7");
  assert.deepEqual(out.compaction.usage, { totalTokens: 1234 }, "usage 原样带回");

  const [prep, model, apiKey, headers, instructions, signal, thinking] = calls[0];
  assert.equal(prep.firstKeptEntryId, "e7");
  assert.equal(model.id, "deepseek-flash");
  assert.equal(apiKey, "k-123");
  assert.deepEqual(headers, { "x-test": "1" });
  assert.ok(instructions.includes(GUARD_INSTRUCTIONS));
  assert.equal(signal, event.signal, "abort signal 要透传");
  assert.equal(thinking, "high");
});

test("guardCompaction 的兜底：缺件就返回 undefined，让 pi 走默认压缩", async () => {
  const event = { preparation: { firstKeptEntryId: "e1" }, reason: "manual" };
  const compact = async () => ({ summary: "x", firstKeptEntryId: "e1", tokensBefore: 1 });

  assert.equal(await guardCompaction({ event, ctx: fakeCtx(), compact: null }), undefined, "没有 compact 就不接管");
  assert.equal(await guardCompaction({ event: undefined, ctx: fakeCtx(), compact }), undefined, "没有 preparation 就不接管");
  assert.equal(await guardCompaction({ event, ctx: { model: undefined }, compact }), undefined, "没有 model 就不接管");
  assert.equal(
    await guardCompaction({ event, ctx: fakeCtx(), compact: async () => ({ summary: "   " }) }),
    undefined,
    "空摘要不接管",
  );
});

test("guardCompaction 把 /compact 的自定义指令一起给到 summarizer", async () => {
  let seen = "";
  const compact = async (_prep, _model, _key, _headers, instructions) => {
    seen = instructions;
    return { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 };
  };
  await guardCompaction({
    event: { preparation: { firstKeptEntryId: "e1" }, customInstructions: "只看报错栈" },
    ctx: fakeCtx(),
    compact,
    frame: frameBlock({ mode: "section" }),
  });
  assert.ok(seen.startsWith("只看报错栈"));
  assert.ok(seen.includes(GUARD_INSTRUCTIONS));
});
