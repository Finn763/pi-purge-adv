/**
 * settings.json 的补丁表。每条都能单独判定、单独撤回。
 *
 * 破甲之所以要动 pi 的 settings，是因为这几项决定的是「宿主愿不愿意把活干下去」，
 * 和提示词无关：
 *   - defaultProjectTrust：项目资源（含项目扩展、项目 settings）加载前的信任门
 *   - compaction：宿主的自动压缩。默认保持开启，用 compaction guard 兜住摘要；
 *                只有 config.compaction === "off" 才写 enabled:false
 *   - defaultTools：默认工具集，缺一个就少一条路
 */
import { normalizeCompactionPolicy } from "./compaction.js";

const ALL_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

const PROJECT_TRUST = {
  id: "PROJECT_TRUST_ALWAYS",
  label: "项目信任门 defaultProjectTrust → always",
  applied: (s) => s.defaultProjectTrust === "always",
  apply: (s) => {
    s.defaultProjectTrust = "always";
  },
  revert: (s) => {
    delete s.defaultProjectTrust;
  },
};

const TOOLS_FULL = {
  id: "TOOLS_FULL",
  label: "默认工具集补齐 read/bash/powershell/edit/write/grep/find/ls",
  applied: (s) => {
    const have = Array.isArray(s.defaultTools) ? s.defaultTools : [];
    return ALL_TOOLS.every((t) => have.includes(t));
  },
  apply: (s) => {
    const have = Array.isArray(s.defaultTools) ? s.defaultTools : [];
    s.defaultTools = [...have, ...ALL_TOOLS.filter((t) => !have.includes(t))];
  },
  revert: (s) => {
    delete s.defaultTools;
  },
};

function dropCompactionEnabled(s) {
  if (!s.compaction || typeof s.compaction !== "object") return false;
  const had = "enabled" in s.compaction;
  delete s.compaction.enabled;
  if (Object.keys(s.compaction).length === 0) delete s.compaction;
  return had;
}

/**
 * 压缩这一条按策略生成：
 *   off   → 写 enabled:false（老行为，长会话不会自动摘要，但会撞上下文上限）
 *   guard / on → 不加任何限制；顺带清掉旧版本留下的 enabled:false
 */
function compactionPatch(policy) {
  if (normalizeCompactionPolicy(policy) === "off") {
    return {
      id: "COMPACTION_OFF",
      label: "自动压缩 compaction.enabled → false",
      applied: (s) => s?.compaction?.enabled === false,
      apply: (s) => {
        s.compaction = { ...(s.compaction && typeof s.compaction === "object" ? s.compaction : {}), enabled: false };
      },
      revert: dropCompactionEnabled,
    };
  }
  return {
    id: "COMPACTION_ON",
    label: "自动压缩保持开启，由 compaction guard 接管摘要",
    applied: (s) => s?.compaction?.enabled !== false,
    apply: dropCompactionEnabled,
    revert: () => {},
  };
}

/** 按当前策略给出的补丁表。 */
export function patchesFor(options = {}) {
  return [PROJECT_TRUST, compactionPatch(options.compaction), TOOLS_FULL];
}

/** 兼容旧调用：不带参数时按默认策略（guard）判定。 */
export const SETTINGS_PATCHES = patchesFor();

/** 判定每条补丁的状态。 */
export function patchStates(settings, options = {}) {
  const safe = settings && typeof settings === "object" ? settings : {};
  return patchesFor(options).map((p) => ({
    id: p.id,
    label: p.label,
    applied: Boolean(p.applied(safe)),
  }));
}

/** 就地应用全部补丁，返回改了哪几条。 */
export function applyPatches(settings, options = {}) {
  const changed = [];
  for (const p of patchesFor(options)) {
    if (p.applied(settings)) continue;
    p.apply(settings);
    changed.push(p.id);
  }
  return changed;
}

/**
 * 没有备份时用这条回滚。压缩两种策略都要试：装了 off 的机器上 enabled:false
 * 只能被 off 那条认领，guard/on 那条认领不了。
 */
export function revertPatches(settings) {
  const changed = [];
  const seen = new Set();
  const candidates = [PROJECT_TRUST, compactionPatch("off"), TOOLS_FULL];
  for (const p of candidates) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (!p.applied(settings)) continue;
    p.revert(settings);
    changed.push(p.id);
  }
  return changed;
}
