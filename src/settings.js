/**
 * settings.json 的补丁表。每条都能单独判定、单独撤回。
 *
 * 破甲之所以要动 pi 的 settings，是因为这几项决定的是「宿主愿不愿意把活干下去」，
 * 和提示词无关：
 *   - defaultProjectTrust：项目资源（含项目扩展、项目 settings）加载前的信任门
 *   - compaction：上下文快满时自动摘要，会把原始内容压掉
 *   - defaultTools：默认工具集，缺一个就少一条路
 */

export const SETTINGS_PATCHES = [
  {
    id: "PROJECT_TRUST_ALWAYS",
    label: "项目信任门 defaultProjectTrust → always",
    applied: (s) => s.defaultProjectTrust === "always",
    apply: (s) => {
      s.defaultProjectTrust = "always";
    },
    revert: (s) => {
      delete s.defaultProjectTrust;
    },
  },
  {
    id: "COMPACTION_OFF",
    label: "自动压缩 compaction.enabled → false",
    applied: (s) => s?.compaction?.enabled === false,
    apply: (s) => {
      s.compaction = { ...(s.compaction && typeof s.compaction === "object" ? s.compaction : {}), enabled: false };
    },
    revert: (s) => {
      if (s.compaction && typeof s.compaction === "object") {
        delete s.compaction.enabled;
        if (Object.keys(s.compaction).length === 0) delete s.compaction;
      }
    },
  },
  {
    id: "TOOLS_FULL",
    label: "默认工具集补齐 read/bash/powershell/edit/write/grep/find/ls",
    applied: (s) => {
      const want = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
      const have = Array.isArray(s.defaultTools) ? s.defaultTools : [];
      return want.every((t) => have.includes(t));
    },
    apply: (s) => {
      const want = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
      const have = Array.isArray(s.defaultTools) ? s.defaultTools : [];
      s.defaultTools = [...have, ...want.filter((t) => !have.includes(t))];
    },
    revert: (s) => {
      delete s.defaultTools;
    },
  },
];

/** 判定每条补丁的状态。 */
export function patchStates(settings) {
  const safe = settings && typeof settings === "object" ? settings : {};
  return SETTINGS_PATCHES.map((p) => ({
    id: p.id,
    label: p.label,
    applied: Boolean(p.applied(safe)),
  }));
}

/** 就地应用全部补丁，返回改了哪几条。 */
export function applyPatches(settings) {
  const changed = [];
  for (const p of SETTINGS_PATCHES) {
    if (p.applied(settings)) continue;
    p.apply(settings);
    changed.push(p.id);
  }
  return changed;
}

/** 没有备份时用这条回滚。 */
export function revertPatches(settings) {
  const changed = [];
  for (const p of SETTINGS_PATCHES) {
    if (!p.applied(settings)) continue;
    p.revert(settings);
    changed.push(p.id);
  }
  return changed;
}
