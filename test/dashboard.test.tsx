import { PassThrough } from "node:stream";

import { render, renderToString, type Instance } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionRecord } from "../src/domain/reducer.js";
import { DEFAULT_PREFERENCES, type DashboardState } from "../src/domain/types.js";
import { Dashboard } from "../src/ui/dashboard.js";
import { buildDashboardModel } from "../src/ui/model.js";
import { SessionList } from "../src/ui/session-list.js";
import type { DashboardProps } from "../src/ui/types.js";

const instances: Instance[] = [];

type TestInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (mode: boolean) => TestInput;
  ref: () => TestInput;
  unref: () => TestInput;
};

function inputStream(): TestInput {
  const stream = new PassThrough() as TestInput;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (mode) => {
    stream.isRaw = mode;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

function outputStream(): NodeJS.WriteStream {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  stream.isTTY = true;
  stream.columns = 120;
  stream.rows = 40;
  return stream as unknown as NodeJS.WriteStream;
}

function state(ids: string[]): DashboardState {
  return {
    connection: ids.length === 0 ? "connecting" : "connected",
    sessions: Object.fromEntries(
      ids.map((id, index) => [
        id,
        createSessionRecord({
          id,
          preview: `Task ${id}`,
          cwd: "/repo",
          createdAt: 100 + index,
          updatedAt: 100 + index,
          status: { type: "idle" },
          turns: [],
        }),
      ]),
    ),
  };
}

function mount(
  dashboardState: DashboardState,
  initialSelectedThreadId: string | undefined,
  onAttach: (threadId: string, initialInput?: string) => void,
  props: Pick<DashboardProps, "onDispatch"> = {},
) {
  const stdin = inputStream();
  const stdout = outputStream();
  const view = (nextState: DashboardState) => (
    <Dashboard
      state={nextState}
      preferences={{
        ...DEFAULT_PREFERENCES,
        order: ["first", "second", "third"],
      }}
      initialSelectedThreadId={initialSelectedThreadId}
      onAttach={onAttach}
      {...props}
    />
  );
  const instance = render(view(dashboardState), {
    stdin,
    stdout,
    stderr: outputStream(),
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  instances.push(instance);
  return { instance, stdin, view };
}

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.unmount();
    await instance.waitUntilExit();
  }
});

describe("Dashboard selection", () => {
  it("renders a blank row between session sections", () => {
    const dashboardState = state(["first", "second"]);
    const model = buildDashboardModel(dashboardState, {
      ...DEFAULT_PREFERENCES,
      pinnedThreadIds: ["first"],
      order: ["first", "second"],
    });

    const output = renderToString(
      <SessionList
        sections={model.sections}
        items={model.items}
        selectedId="first"
        maxRows={12}
        width={120}
      />,
    );
    const lines = output.split("\n");
    const completedHeading = lines.findIndex((line) => line.includes("Completed"));

    expect(completedHeading).toBeGreaterThan(0);
    expect(lines[completedHeading - 1]).toBe("");
  });

  it("restores the attached row after an empty loading render", async () => {
    const firstAttach = vi.fn<(threadId: string) => void>();
    const first = mount(state(["first", "second", "third"]), undefined, firstAttach);
    await first.instance.waitUntilRenderFlush();

    first.stdin.write("\u001b[B");
    await first.instance.waitUntilRenderFlush();
    first.stdin.write("\u001b[B");
    await first.instance.waitUntilRenderFlush();
    first.stdin.write("\r");
    await first.instance.waitUntilRenderFlush();
    expect(firstAttach).toHaveBeenCalledWith("third");

    first.instance.unmount();
    await first.instance.waitUntilExit();
    instances.splice(instances.indexOf(first.instance), 1);

    const restoredAttach = vi.fn<(threadId: string) => void>();
    const restored = mount(state([]), firstAttach.mock.calls[0]?.[0], restoredAttach);
    await restored.instance.waitUntilRenderFlush();
    restored.instance.rerender(restored.view(state(["first", "second", "third"])));
    await restored.instance.waitUntilRenderFlush();

    restored.stdin.write("\r");
    await restored.instance.waitUntilRenderFlush();
    expect(restoredAttach).toHaveBeenCalledWith("third");
  });

  it("types a new task immediately and deletes words with ctrl+backspace", async () => {
    const onDispatch = vi.fn();
    const onAttach = vi.fn();
    const dashboard = mount(state(["first"]), undefined, onAttach, { onDispatch });
    await dashboard.instance.waitUntilRenderFlush();

    dashboard.stdin.write("hello world");
    await dashboard.instance.waitUntilRenderFlush();
    dashboard.stdin.write("\u001b[127;5u");
    await dashboard.instance.waitUntilRenderFlush();
    dashboard.stdin.write("\r");
    await dashboard.instance.waitUntilRenderFlush();

    expect(onDispatch).toHaveBeenCalledWith("hello", undefined);
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("opens the selected native composer with a slash command seed", async () => {
    const onAttach = vi.fn<(threadId: string, initialInput?: string) => void>();
    const dashboard = mount(state(["first"]), undefined, onAttach);
    await dashboard.instance.waitUntilRenderFlush();

    dashboard.stdin.write("/");
    await dashboard.instance.waitUntilRenderFlush();

    expect(onAttach).toHaveBeenCalledWith("first", "/");
  });

  it("opens the selected chat with left arrow while the draft is empty", async () => {
    const onAttach = vi.fn<(threadId: string, initialInput?: string) => void>();
    const dashboard = mount(state(["first"]), undefined, onAttach);
    await dashboard.instance.waitUntilRenderFlush();

    dashboard.stdin.write("\u001b[D");
    await dashboard.instance.waitUntilRenderFlush();

    expect(onAttach).toHaveBeenCalledWith("first");
  });
});
