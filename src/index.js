/**
 * pi-purge-adv 破甲扩展本体。
 *
 * 生效位置全部在宿主层，不碰模型、不碰工具实现：
 *   before_agent_start      → 换 preamble / 重建 tools+rules / 接追加规则（section 模式）
 *                             或整段接管提示词（force / payload 模式）
 *   context_with_system     → 改写 transcript 里的 system 消息（payload 模式）
 *   before_provider_request → 改写最终出网的 provider 载荷（payload 模式）
 *
 * 配置与注入文本每次都按 mtime 重新读取，改完不用重启 pi。
 */
import fs from "node:fs";
import path from "node:path";
import { configPath, envVar, injectPath, logPath } from "./paths.js";
import { readConfig, readInject, writeConfig, stripBom, MODES } from "./config.js";
import {
  applySectionMode,
  buildForcedPrompt,
  scrubProviderPayload,
  scrubSystemMessages,
  splitInject,
} from "./prompt.js";
import { looksLikeRefusal, retryDecision } from "./retry.js";

const state = {
  stamp: "",
  config: null,
  persona: "",
  tail: "",
  lastForced: "",
  error: null,
};

/**
 * 拒答重试状态。默认关（PI_PURGE_ADV_RETRY=1 才开），评测与日常都先跑不重试的口径。
 * attempts = 本轮已经发生的回答次数（首发算 1）。
 */
const retryState = {
  attempts: 1,
  prompt: "",
};

function retryConfig() {
  const enabled = envVar("RETRY") === "1";
  const max = Number.parseInt(envVar("RETRY_MAX") || "", 10);
  return { enabled, maxAttempts: Number.isFinite(max) && max > 0 ? max : 2 };
}

function textOfAssistant(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function hasToolCall(message) {
  return (
    Array.isArray(message?.content) &&
    message.content.some((block) => block?.type === "toolCall" || block?.type === "tool_use")
  );
}

function statStamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

/**
 * 评测专用的注入文件覆盖（脚本 eval-bank.mjs 会设 PI_PURGE_ADV_INJECT）。
 * 路径相对 cwd 解析；文件不存在时不生效（回落到运行时目录的 prompt-inject.md），
 * 避免父进程泄漏的环境变量把正常测试/会话的注入文本顶掉。
 */
function evalInjectFile() {
  const raw = envVar("INJECT");
  if (!raw) return "";
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return fs.existsSync(resolved) ? resolved : "";
}

function refresh() {
  const injectFile = evalInjectFile() || injectPath();
  const stamp = `${statStamp(configPath())}|${statStamp(injectFile)}|${envVar("MODE") || ""}`;
  if (stamp === state.stamp && state.config) return state;
  const { config, error } = readConfig();
  // 评测时用环境变量临时压过配置，不写用户的 config.json
  if (envVar("MODE") && MODES.includes(envVar("MODE"))) {
    config.mode = envVar("MODE");
  }
  let rawInject = "";
  try {
    rawInject = stripBom(fs.readFileSync(injectFile, "utf8"));
  } catch {
    rawInject = readInject();
  }
  const { head, tail } = splitInject(rawInject);
  state.stamp = stamp;
  state.config = config;
  state.persona = head;
  state.tail = tail;
  state.error = error;
  return state;
}

function note(msg) {
  if (!state.config?.log) return;
  try {
    fs.mkdirSync(logPath().replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* 日志失败不影响对话 */
  }
}

function describe(config, persona, tail) {
  return [
    `mode=${config.mode}`,
    `persona=${persona.length}B`,
    `tail=${tail.length}B`,
    `guidelines=${config.guidelines.length}`,
  ].join(" ");
}

export default function piPurge(pi) {
  pi.on("before_agent_start", (event) => {
    try {
      const cfgState = refresh();
      const { config, persona, tail } = cfgState;

      // 每轮开始重置重试计数与原始请求
      retryState.attempts = 1;
      retryState.prompt = typeof event?.prompt === "string" ? event.prompt : "";

      if (config.mode === "off") return undefined;

      const options = event?.systemPromptOptions;

      if (config.mode === "soft") {
        if (config.appendInject) {
          const extra = [persona, tail].filter(Boolean).join("\n\n");
          if (extra && options) {
            options.appendSystemPrompt = [String(options.appendSystemPrompt ?? "").trim(), extra]
              .filter(Boolean)
              .join("\n\n");
          }
        }
        state.lastForced = "";
        note(`soft hit ${describe(config, persona, tail)}`);
        return undefined;
      }

      if (config.mode === "section") {
        const changes = applySectionMode(options, { persona, tail, config });
        state.lastForced = "";
        note(`section hit ${changes.join(",")} ${describe(config, persona, tail)}`);
        return undefined;
      }

      // force / payload：整段接管。payload 模式后面还会在 provider 边界再兜一次。
      const forced = buildForcedPrompt(options, { persona, tail, config });
      state.lastForced = forced;
      note(`${config.mode} hit ${describe(config, persona, tail)} len=${forced.length}`);
      return { systemPrompt: forced };
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
      note(`before_agent_start error: ${state.error}`);
      return undefined;
    }
  });

  pi.on("context_with_system", (event) => {
    try {
      const { config } = refresh();
      if (config.mode !== "payload" || !state.lastForced) return undefined;
      const messages = scrubSystemMessages(event?.messages, state.lastForced);
      note(`context_with_system scrubbed ${Array.isArray(event?.messages) ? event.messages.length : 0} -> ${messages.length}`);
      return { messages };
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
      return undefined;
    }
  });

  pi.on("before_provider_request", (event) => {
    try {
      let payload = event?.payload;
      let touched = false;

      // assistant 预填（"续写"型越狱）：与 mode 无关，用来对比"用户消息包装"这类手法。
      // PI_PURGE_ADV_PREFILL_FILE 指向一段文本，会作为 assistant 消息追加到出网载荷末尾。
      const prefillFile = envVar("PREFILL_FILE");
      if (prefillFile && payload && Array.isArray(payload.messages)) {
        try {
          const prefill = fs.readFileSync(prefillFile, "utf8").trim();
          if (prefill) {
            payload = { ...payload, messages: [...payload.messages, { role: "assistant", content: prefill }] };
            touched = true;
            note(`prefill appended ${prefill.length}B`);
          }
        } catch {
          /* 读不到就当没配 */
        }
      }

      const { config } = refresh();
      if (config.mode === "payload" && state.lastForced) {
        payload = scrubProviderPayload(payload, state.lastForced);
        touched = true;
        note("before_provider_request scrubbed payload");
      }

      return touched ? payload : undefined;
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
      return undefined;
    }
  });

  // 响应侧：认出拒答就换措辞重问一次（默认关，PI_PURGE_ADV_RETRY=1 开）。
  pi.on("turn_end", (event) => {
    try {
      const { config } = refresh();
      if (config.mode === "off") return undefined;

      const { enabled, maxAttempts } = retryConfig();
      if (!enabled) return undefined;

      const message = event?.message;
      if (message?.role !== "assistant") return undefined;
      if (hasToolCall(message)) return undefined;
      if (Array.isArray(event?.toolResults) && event.toolResults.length) return undefined;

      const text = textOfAssistant(message);
      const refusal = looksLikeRefusal(text, { prompt: retryState.prompt });
      const decision = retryDecision({
        enabled,
        attempt: retryState.attempts,
        maxAttempts,
        refusal,
        prompt: retryState.prompt || text.slice(0, 200),
      });

      note(`retry? ${decision.reason} attempt=${retryState.attempts} refusal=${refusal} len=${text.length}`);
      if (!decision.retry) return undefined;

      retryState.attempts += 1;
      return {
        entries: [
          {
            type: "custom_message",
            customType: "pi-purge-adv-retry",
            content: decision.prompt,
            display: true,
          },
        ],
        continue: true,
      };
    } catch (err) {
      state.error = String(err && err.message ? err.message : err);
      note(`turn_end error: ${state.error}`);
      return undefined;
    }
  });

  pi.registerCommand("purge", {
    description: "pi-purge-adv：查看破甲状态 / 切换模式 / 打开注入文件",
    handler: async (args, ctx) => {
      const { config, persona, tail, error } = refresh();
      const argv = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = argv[0] || "status";
      const notify = (msg, kind = "info") => {
        try {
          ctx?.ui?.notify?.(msg, kind);
        } catch {
          /* 无 UI 时静默 */
        }
      };

      if (sub === "status") {
        notify(
          [
            `pi-purge-adv ${config.mode} · persona ${persona.length}B · tail ${tail.length}B`,
            `config: ${configPath()}`,
            `inject: ${injectPath()}`,
            error ? `配置解析失败，已回落默认值: ${error}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        return;
      }

      if (sub === "mode") {
        const want = String(argv[1] ?? "").toLowerCase();
        if (!MODES.includes(want)) {
          notify(`可用模式: ${MODES.join(" | ")}`, "warning");
          return;
        }
        writeConfig({ ...config, mode: want });
        refresh();
        state.stamp = "";
        notify(`pi-purge-adv 模式 → ${want}`, "info");
        return;
      }

      if (sub === "edit" || sub === "path") {
        notify(`注入文件: ${injectPath()}\n配置: ${configPath()}`, "info");
        return;
      }

      notify(`用法: /purge [status|mode <${MODES.join("|")}>|edit]`, "info");
    },
  });
}
