import type { DashboardState, Preferences, SessionRecord } from "../domain/types.js";
import { basename, semanticGroup } from "./format.js";
import type {
  DashboardCounts,
  DashboardModel,
  SemanticSessionGroup,
  SessionListItem,
  SessionSection,
} from "./types.js";

const STATE_GROUPS: ReadonlyArray<{
  id: SemanticSessionGroup;
  label: string;
}> = [
  { id: "needsInput", label: "Awaiting input" },
  { id: "working", label: "Working" },
  { id: "completed", label: "Completed" },
];

export function buildDashboardModel(
  state: DashboardState,
  preferences: Preferences,
): DashboardModel {
  const pinnedIds = new Set(preferences.pinnedThreadIds);
  const explicitOrder = new Map(
    preferences.order.map((threadId, index) => [threadId, index] as const),
  );
  const records = Object.values(state.sessions);
  const items = records.map<SessionListItem>((record) => ({
    id: record.thread.id,
    record,
    semanticGroup: semanticGroup(record),
    pinned: pinnedIds.has(record.thread.id),
  }));

  items.sort((left, right) => {
    const leftRank = explicitOrder.get(left.id);
    const rightRank = explicitOrder.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return -1;
      if (rightRank === undefined) return 1;
      return leftRank - rightRank;
    }
    return right.record.thread.createdAt - left.record.thread.createdAt ||
      left.id.localeCompare(right.id);
  });

  const counts: DashboardCounts = {
    needsInput: 0,
    working: 0,
    completed: 0,
  };
  for (const item of items) counts[item.semanticGroup] += 1;

  const pinnedOrder = new Map(
    preferences.pinnedThreadIds.map((threadId, index) => [threadId, index] as const),
  );
  const pinned = items.filter((item) => item.pinned).sort((left, right) => {
    const leftRank = explicitOrder.get(left.id);
    const rightRank = explicitOrder.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return (pinnedOrder.get(left.id) ?? 0) - (pinnedOrder.get(right.id) ?? 0);
  });
  const unpinned = items.filter((item) => !item.pinned);
  const sections: SessionSection[] = [];

  if (preferences.groupBy === "cwd") {
    const cwdGroups = new Map<string, SessionListItem[]>();
    for (const item of unpinned) {
      const cwd = item.record.thread.cwd || "Unknown project";
      const group = cwdGroups.get(cwd);
      if (group) group.push(item);
      else cwdGroups.set(cwd, [item]);
    }
    for (const [cwd, groupItems] of cwdGroups) {
      sections.push({ id: `cwd:${cwd}`, label: basename(cwd), items: groupItems });
    }
  } else {
    for (const group of STATE_GROUPS) {
      const groupItems = unpinned.filter((item) => item.semanticGroup === group.id);
      if (groupItems.length > 0) {
        sections.push({ id: group.id, label: group.label, items: groupItems });
      }
    }
  }

  if (pinned.length > 0) {
    sections.push({ id: "pinned", label: "Pinned", items: pinned });
  }

  return { counts, sections, items: sections.flatMap((section) => section.items) };
}
