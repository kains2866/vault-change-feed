// src/core/merge.ts
function sumStats(group) {
  let added = 0;
  let removed = 0;
  for (const e of group) {
    if (e.stat === null) return null;
    added += e.stat.added;
    removed += e.stat.removed;
  }
  return { added, removed };
}
function mergeGroup(group) {
  const first = group[0];
  const last = group[group.length - 1];
  if (first.op === "create" && last.op === "delete") return [];
  const firstRename = group.find((e) => e.op === "rename");
  const deleteCount = group.reduce((n, e) => n + (e.op === "delete" ? 1 : 0), 0);
  if (last.op === "delete" && firstRename && deleteCount === 1) {
    return [
      {
        seq: Math.max(...group.map((e) => e.seq)),
        ts: Math.max(...group.map((e) => e.ts)),
        op: "delete",
        path: firstRename.oldPath ?? first.path,
        stat: last.stat,
        source: last.source
      }
    ];
  }
  if (firstRename && group.some((e) => e.op === "delete")) return group;
  let op;
  let stat;
  let oldPath;
  if (last.op === "delete") {
    op = "delete";
    stat = last.stat;
  } else if (group.some((e) => e.op === "delete")) {
    op = "modify";
    stat = null;
  } else if (first.op === "create") {
    op = "create";
    stat = sumStats(group);
  } else if (firstRename) {
    op = "rename";
    oldPath = firstRename.oldPath;
    stat = sumStats(group);
  } else {
    op = "modify";
    stat = sumStats(group);
  }
  const merged = {
    seq: Math.max(...group.map((e) => e.seq)),
    ts: Math.max(...group.map((e) => e.ts)),
    op,
    path: first.path,
    stat,
    source: last.source
  };
  if (op === "rename" && oldPath !== void 0) merged.oldPath = oldPath;
  return [merged];
}
function mergeEvents(events) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const groups = /* @__PURE__ */ new Map();
  const out = [];
  for (const e of sorted) {
    if (e.op === "resync") {
      out.push(e);
      continue;
    }
    const g = groups.get(e.path);
    if (g) g.push(e);
    else groups.set(e.path, [e]);
  }
  for (const g of groups.values()) {
    out.push(...mergeGroup(g));
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
export {
  mergeEvents
};
