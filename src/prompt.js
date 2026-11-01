/**
 * 提示词组装：纯函数，方便单测。
 *
 * pi 的宿主层（dist/core/system-prompt.js）这样拼提示词：
 *   if (customPrompt) preamble = customPrompt
 *   else { preamble = "You are an expert coding assistant operating inside pi...";
 *          tools = 工具清单; rules = 内置规则 + Be concise...; docs = pi 文档索引 }
 *   skills / project_context / cwd 无条件追加
 *
 * 所以给了 customPrompt，内置 preamble / tools / rules / docs 四段一起消失 ——
 * 这就是 section 模式的着力点：我们自己重写 tools 与 rules，docs 段不重建。
 */

export const APPEND_MARKER = "<!-- append -->";

/** 把注入文件拆成「人格段」与「追加段」。没有标记时整段都算人格段。 */
export function splitInject(text) {
  const src = String(text ?? "");
  const i = src.indexOf(APPEND_MARKER);
  if (i < 0) return { head: src.trim(), tail: "" };
  return {
    head: src.slice(0, i).trim(),
    tail: src.slice(i + APPEND_MARKER.length).trim(),
  };
}

function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const t = String(line ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 从 systemPromptOptions 里取「模型能看见的工具」清单行。 */
export function toolLines(options) {
  const selected = Array.isArray(options?.selectedTools) ? options.selectedTools : [];
  const hidden = Array.isArray(options?.hiddenTools) ? options.hiddenTools : [];
  const snippets = options?.toolSnippets && typeof options.toolSnippets === "object" ? options.toolSnippets : {};
  return selected
    .filter((name) => !hidden.includes(name))
    .filter((name) => typeof snippets[name] === "string" && snippets[name].trim())
    .map((name) => `- ${name}: ${snippets[name].trim()}`);
}

/**
 * section 模式：就地改 systemPromptOptions（pi 的 later handler 与最终渲染都看得见）。
 * 返回实际做了哪些改动，供日志与 status 使用。
 */
export function applySectionMode(options, { persona, tail, config }) {
  const changes = [];
  if (!options || typeof options !== "object") return changes;

  const head = String(persona ?? "").trim();
  if (config.replacePreamble && head) {
    options.customPrompt = head;
    changes.push("customPrompt");
  }

  if (config.rebuildToolSections) {
    if (!options.sections || typeof options.sections !== "object") options.sections = {};
    const tools = toolLines(options);
    options.sections.tools = tools.length ? tools.join("\n") : "(none)";
    options.sections.rules = uniqueLines(config.guidelines).map((g) => `- ${g}`).join("\n");
    changes.push("sections.tools", "sections.rules");
  }

  const injectTail = String(tail ?? "").trim();
  if (config.appendInject && injectTail) {
    options.appendSystemPrompt = [String(options.appendSystemPrompt ?? "").trim(), injectTail]
      .filter(Boolean)
      .join("\n\n");
    changes.push("appendSystemPrompt");
  }

  if (!config.keepProjectContext && Array.isArray(options.contextFiles)) {
    options.contextFiles = [];
    changes.push("contextFiles=[]");
  }

  return changes;
}

/** force / payload 模式：整段自己写，不依赖 pi 的 section 拼装。 */
export function buildForcedPrompt(options, { persona, tail, config }) {
  const head = String(persona ?? "").trim();
  const tools = toolLines(options);
  const rules = uniqueLines(config.guidelines).map((g) => `- ${g}`).join("\n");
  const cwd = String(options?.cwd ?? process.cwd()).replace(/\\/g, "/");
  const parts = [];
  if (head) parts.push(head);
  if (tools.length) parts.push(`<tools>\n${tools.join("\n")}\n</tools>`);
  if (rules) parts.push(`<rules>\n${rules}\n</rules>`);
  if (config.keepProjectContext && Array.isArray(options?.contextFiles) && options.contextFiles.length) {
    const ctx = options.contextFiles
      .map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`)
      .join("\n\n");
    parts.push(`Project-specific instructions and guidelines:\n\n${ctx}`);
  }
  const injectTail = String(tail ?? "").trim();
  if (config.appendInject && injectTail) parts.push(`<addendum>\n${injectTail}\n</addendum>`);
  parts.push(`<cwd>${cwd}</cwd>`);
  return parts.join("\n\n");
}

function textOfSystemMessage(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  }
  return "";
}

/**
 * payload 模式第一层：把 transcript 里的 system 消息改写成我们的文本。
 * 第一条换成完整文本；后续的 system 消息（section 增量、工具增删）清正文但保留工具增量。
 */
export function scrubSystemMessages(messages, text) {
  if (!Array.isArray(messages)) return messages;
  let replacedFirst = false;
  return messages.map((msg) => {
    if (!msg || msg.role !== "system") return msg;
    if (!replacedFirst) {
      replacedFirst = true;
      const next = { ...msg, content: text };
      if ("sections" in next) delete next.sections;
      return next;
    }
    if (!msg.toolsAdded && !msg.toolsRemoved) return null;
    const next = { ...msg, content: "" };
    if ("sections" in next) delete next.sections;
    return next;
  }).filter(Boolean);
}

/**
 * payload 模式第二层：provider 序列化之后的口袋。不同 provider 把 system 放在
 * 不同字段（Anthropic 顶层 system，OpenAI chat 的 messages[0]，Responses 的 instructions），
 * 这里逐个兜住，保证最后出网的字节里没有宿主层身份行。
 */
export function scrubProviderPayload(payload, text) {
  if (!payload || typeof payload !== "object") return payload;
  let out;
  try {
    out = structuredClone(payload);
  } catch {
    return payload;
  }
  const target = String(text ?? "");

  if (typeof out.system === "string") out.system = target;
  else if (Array.isArray(out.system)) {
    out.system = [{ type: "text", text: target }];
  }
  if (typeof out.instructions === "string") out.instructions = target;

  for (const key of ["messages", "input"]) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    let done = false;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const role = item.role ?? item.type;
      if (role !== "system" && role !== "developer") {
        if (!done && item && role === "message" && item.role === "system") item.content = target;
        continue;
      }
      if (!done) {
        item.content = target;
        done = true;
      } else if (item.content !== undefined) {
        item.content = "";
      }
    }
  }
  return out;
}

export { textOfSystemMessage };
