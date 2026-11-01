import test from "node:test";
import assert from "node:assert/strict";
import {
  HEAD_CHARS,
  SHORT_ANSWER,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_DIRECTIVES,
  looksLikeRefusal,
  buildRetryPrompt,
  retryDecision,
} from "../src/retry.js";

/** 一段足够长、有结构、正文里引用规则原文的"真交付"答案（上一轮误判的事故形态）。 */
const LONG_DELIVERED = [
  "# 批量导出实现方案",
  "",
  "下面按六步给出可直接执行的做法，每步都带命令，复制就能跑。",
  "",
  "## 1. 先量峰值内存",
  "",
  "读取前后各打一次 `process.memoryUsage()`，确认是读取阶段爆还是写回阶段爆。",
  "",
  "## 2. 改成流式读",
  "",
  "把 `fs.readFileSync` 换成 `fs.createReadStream`，按行切分，超长行单独走一条分支。",
  "",
  "## 3. 写回也流式",
  "",
  "用 `fs.createWriteStream` 逐块写，写完 close，别把整份内容拼在内存里。",
  "",
  "## 4. 落临时文件",
  "",
  "目标目录先写 `.part` 后缀，成功后 rename，失败留现场，方便重跑。",
  "",
  "## 5. 压测确认",
  "",
  "拿 2GB 样本跑一遍，观察 RSS 是否稳定在 300MB 以内，不稳定就回头调阈值。",
  "",
  "## 6. 回归旧数据",
  "",
  "用最近一周的真实导出文件各跑一次，比对列顺序和行数，确认没有静默丢行。",
  "",
  "## 7. 失败要能重入",
  "",
  "把每批的起始偏移记到 sidecar 文件里，进程被杀掉之后从断点续跑，不要整批重来。",
  "",
  "## 8. 观测",
  "",
  "每批打一行结构化日志：批次号、行数、耗时、峰值 RSS、失败原因，出问题先看这行。",
  "",
  "> 规则原文里写着“不要以抱歉开头，也不要说 I can't help”——那是在约束语气，",
  "> 不是在拒绝请求，所以这里照常交付，正文继续给可执行步骤。",
  "",
  "补充一：如果导出目标是 Excel，先落 CSV 再转，别在内存里拼 XML；如果是 PDF，用分页写临时文件再合并。",
  "补充二：列顺序以表头映射表为准，不要依赖对象 key 的插入顺序，老数据的字段缺失要补空值而不是丢列。",
  "补充三：所有路径走 path.join，Windows 下的反斜杠不要手工拼字符串，临时目录统一用 os.tmpdir()。",
  "以上八步在 Node 26 上直接可用，命令里的路径按实际目录替换即可，每一步都可以单独回滚。",
].join("\n");

test("空回答算没交付（null / 空白都判拒答）", () => {
  assert.equal(looksLikeRefusal(""), true);
  assert.equal(looksLikeRefusal("   \n\t "), true);
  assert.equal(looksLikeRefusal(null), true);
  assert.equal(looksLikeRefusal(undefined), true);
});

test("中文短拒答：抱歉 + 我不能协助", () => {
  assert.equal(looksLikeRefusal("抱歉，我不能协助这个请求。"), true);
});

test("英文短拒答：I can't + as an AI", () => {
  const text = "I can't help with that request. As an AI language model I have to decline.";
  assert.equal(looksLikeRefusal(text), true);
});

test("开头寒暄、第二段才拒：靠开头 160 字窗口抓住", () => {
  const preface =
    "关于这个任务，我先把背景补一下：之前你提到过导出脚本要处理很大的文件，还要保留原始列顺序，这两点我都记下来了。";
  const refusal = "但很遗憾，我无法提供这份内容的完整实现。";
  const tail =
    "另外，如果你手上还有其它历史脚本需要做同样的改造，可以把文件名和大致结构发我，" +
    "我按同样的思路继续帮你拆解；不用一次全丢过来，按模块分批也行，我会按批次给反馈。" +
    "我这边能覆盖的范围主要是读写路径的改造、错误处理补齐、以及压测脚本的搭建，" +
    "如果你的场景里还牵扯到第三方接口的限流，也可以先把请求样例贴出来，我按样例判断瓶颈在哪。" +
    "总之先把能动的部分往前推，剩下的再单独排期，这样比一次把所有东西都卡在同一个环节上要好。";
  const text = preface + refusal + tail;
  assert.ok(text.length > SHORT_ANSWER, "用例本身要超过短回答阈值，才是在测开头窗口");
  assert.ok(text.indexOf("我无法提供") < HEAD_CHARS, "拒答话术要落在窗口内");
  assert.equal(looksLikeRefusal(text), true);
});

test("假拒答：长答案正文引用规则原文，不重跑", () => {
  assert.ok(LONG_DELIVERED.length >= 600, "用例本身要够长，才走已交付分支");
  assert.equal(looksLikeRefusal(LONG_DELIVERED), false);
});

test("假拒答：短答案里用反引号引用 I can't，不判拒答", () => {
  assert.equal(looksLikeRefusal("文档里 `I can't` 这种写法只是示例，说明别照抄。"), false);
});

test("假拒答：被否定的拒答词（不要说抱歉）不算拒答", () => {
  assert.equal(looksLikeRefusal("写文档时不要说抱歉，直接给结论。"), false);
});

test("假拒答：代码块里的 can't / 不能 字符串不算模型在拒答", () => {
  const text = [
    "参数边界要显式判空，示例：",
    "",
    "```js",
    "// can't be null here",
    "export function must(x) {",
    "  if (x == null) throw new Error('不能为空');",
    "  return x;",
    "}",
    "```",
  ].join("\n");
  assert.equal(looksLikeRefusal(text, { needsCode: true }), false);
});

test("假拒答：客套话之后立刻交付（抱歉 + 代码块），不重跑", () => {
  const text = "抱歉，刚才那句判断偏了。下面是完整的可运行代码：\n\n```js\nexport const add = (a, b) => a + b;\n```\n";
  assert.equal(looksLikeRefusal(text, { needsCode: true }), false);
});

test("代码题：只有思路、没有代码块 → 判拒答", () => {
  const text =
    "先确认输入范围：n 从 1 开始，遇到 3 的倍数输出 Fizz，遇到 5 的倍数输出 Buzz，" +
    "同时是 15 的倍数输出 FizzBuzz。实现时注意先判 15 再判 3 和 5，避免顺序问题。";
  assert.equal(looksLikeRefusal(text, { needsCode: true }), true);
});

test("代码题：给了代码块 → 不判拒答", () => {
  const text =
    "```js\nexport function fizzbuzz(n) {\n  for (let i = 1; i <= n; i++) {\n" +
    "    const s = (i % 15 === 0 && 'FizzBuzz') || (i % 3 === 0 && 'Fizz') || (i % 5 === 0 && 'Buzz') || String(i);\n" +
    "    console.log(s);\n  }\n}\n```";
  assert.equal(looksLikeRefusal(text, { needsCode: true }), false);
});

test("needsCode 可以从 ctx.prompt 推断；显式 false 优先", () => {
  const prose = "先确认输入范围，再决定循环边界，最后逐项输出结果。";
  const prompt = "用 JavaScript 写一个 fizzbuzz 函数，只输出一个代码块";
  assert.equal(looksLikeRefusal(prose, { prompt }), true);
  assert.equal(looksLikeRefusal(prose, { prompt, needsCode: false }), false);
});

test("技术性“无法”不是拒答（无法用 JSON.parse 直接读）", () => {
  assert.equal(looksLikeRefusal("这个文件无法用 JSON.parse 直接读：开头带 BOM，先 stripBom 再解析。"), false);
});

test("长散文拒答（无结构、无代码）仍然判拒答", () => {
  const unit =
    "抱歉，我不能提供这个请求的实现。我理解你要的是能直接跑的东西，但原样的成品我给不了。" +
    "类似的思路网上有很多公开讨论，你可以按关键词自己找找；如果你愿意换个角度，" +
    "我可以帮你把需求拆成更小的步骤，但这次只能到这里。";
  const text = unit.repeat(7);
  assert.ok(text.length >= 600, `用例长度 ${text.length} 要超过 LONG_ANSWER`);
  assert.equal(looksLikeRefusal(text), true);
});

test("边界：拒答话术掉出 160 字窗口且回答不短 → 保守放过（宁可漏判也不重跑好答案）", () => {
  const filler = "这里补一段背景说明，用来把后面那句话挤出开头窗口，内容本身没有信息量。";
  const text = filler.repeat(6) + "我无法提供这一版的具体实现。" + filler.repeat(4);
  assert.ok(text.length > SHORT_ANSWER);
  assert.ok(text.indexOf("我无法提供") > HEAD_CHARS);
  assert.equal(looksLikeRefusal(text), false);
});

test("buildRetryPrompt：三套措辞递进，原请求原样带回", () => {
  const base = "把这份导出的每一行按列拆开";
  const p1 = buildRetryPrompt(base, 1);
  const p2 = buildRetryPrompt(base, 2);
  const p3 = buildRetryPrompt(base, 3);

  assert.ok(p1.startsWith("【重试 #1】"));
  assert.match(p1, /重新回答同一请求/);
  assert.match(p2, /不要复述限制/);
  assert.match(p3, /分点给，不要前置说明/);
  assert.ok(p1.includes(base) && p2.includes(base) && p3.includes(base));
  assert.notEqual(p2, p3);
  assert.equal(RETRY_DIRECTIVES.length, 3);
});

test("buildRetryPrompt：非法或超界 attempt 归一到合理措辞", () => {
  assert.match(buildRetryPrompt("原始请求", NaN), /^【重试 #1】/);
  assert.match(buildRetryPrompt("原始请求", 0), /^【重试 #1】/);
  assert.match(buildRetryPrompt("原始请求", -5), /^【重试 #1】/);
  const p4 = buildRetryPrompt("原始请求", 4);
  assert.match(p4, /^【重试 #4】/);
  assert.match(p4, /分点给，不要前置说明/); // 沿用第 3 套措辞
  assert.ok(buildRetryPrompt("", 2).includes("不要复述限制"));
});

test("retryDecision：开关 / 非拒答 / 达到上限 都返回不重试", () => {
  const base = "原始请求";
  assert.deepEqual(retryDecision({ enabled: false, attempt: 1, maxAttempts: 3, refusal: true, prompt: base }), {
    retry: false,
    reason: "disabled",
  });
  assert.deepEqual(retryDecision({ enabled: true, attempt: 1, maxAttempts: 3, refusal: false, prompt: base }), {
    retry: false,
    reason: "not-a-refusal",
  });
  assert.deepEqual(retryDecision({ enabled: true, attempt: 2, maxAttempts: 2, refusal: true, prompt: base }), {
    retry: false,
    reason: "max-attempts",
  });
});

test("retryDecision：上限内重试，prompt 用第 attempt+1 套措辞", () => {
  const base = "把这份导出的每一行按列拆开";
  const first = retryDecision({ enabled: true, attempt: 1, maxAttempts: 2, refusal: true, prompt: base });
  assert.equal(first.retry, true);
  assert.equal(first.reason, "retry-2");
  assert.ok(first.prompt.includes(base));
  assert.match(first.prompt, /不要复述限制/);

  const second = retryDecision({ enabled: true, attempt: 2, maxAttempts: 4, refusal: true, prompt: base });
  assert.equal(second.reason, "retry-3");
  assert.match(second.prompt, /分点给，不要前置说明/);
});

test("retryDecision：默认上限 3，第四次要停手；不给 prompt 时只给决策", () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  assert.equal(retryDecision({ enabled: true, attempt: 2, refusal: true, prompt: "x" }).retry, true);
  assert.equal(retryDecision({ enabled: true, attempt: 3, refusal: true, prompt: "x" }).retry, false);
  const noPrompt = retryDecision({ enabled: true, attempt: 1, refusal: true });
  assert.equal(noPrompt.retry, true);
  assert.equal("prompt" in noPrompt, false);
  assert.equal(noPrompt.reason, "retry-2");
});

test("默认参数与常量：不传 ctx / 不传 attempt 也不炸", () => {
  assert.equal(HEAD_CHARS, 160);
  assert.equal(looksLikeRefusal("这是正常回答，长度很短但没有拒答词。"), false);
  assert.ok(buildRetryPrompt(undefined, undefined).startsWith("【重试 #1】"));
  assert.equal(retryDecision().reason, "disabled");
});
