import { emitKeypressEvents } from "node:readline";
import { LlmWikiError } from "./errors.js";

export interface SelectionState {
  cursor: number;
  selected: boolean[];
  outcome: "active" | "confirmed" | "cancelled";
}

export type SelectionKey = "up" | "down" | "space" | "enter" | "escape";

export function reduceSelectionState(
  state: SelectionState,
  key: SelectionKey,
): SelectionState {
  if (state.outcome !== "active" || state.selected.length === 0) {
    return state;
  }
  switch (key) {
    case "up":
      return {
        ...state,
        cursor: (state.cursor - 1 + state.selected.length) % state.selected.length,
      };
    case "down":
      return {
        ...state,
        cursor: (state.cursor + 1) % state.selected.length,
      };
    case "space": {
      const selected = [...state.selected];
      selected[state.cursor] = !selected[state.cursor];
      return { ...state, selected };
    }
    case "enter":
      return { ...state, outcome: "confirmed" };
    case "escape":
      return { ...state, outcome: "cancelled" };
  }
}

export async function selectFirstLevelSources(
  entries: string[],
  initiallySelected: ReadonlySet<string>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string[]> {
  if (entries.length === 0) {
    throw new LlmWikiError("EMPTY_SOURCE_SCOPE", "No eligible first-level sources were found.");
  }
  if (!isRawTty(input)) {
    throw new LlmWikiError(
      "INTERACTIVE_TTY_REQUIRED",
      "Interactive source selection requires a TTY.",
    );
  }

  let state: SelectionState = {
    cursor: 0,
    selected: entries.map((entry) => initiallySelected.has(entry)),
    outcome: "active",
  };
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  renderSelection(entries, state, output, false);

  try {
    await new Promise<void>((resolve, reject) => {
      const onKeypress = (
        character: string,
        key: { name?: string; ctrl?: boolean; sequence?: string },
      ): void => {
        const mapped = mapKey(character, key);
        if (mapped === null) {
          return;
        }
        state = reduceSelectionState(state, mapped);
        renderSelection(entries, state, output, true);
        if (state.outcome === "confirmed") {
          cleanup();
          resolve();
        } else if (state.outcome === "cancelled") {
          cleanup();
          reject(new LlmWikiError("INITIALIZATION_CANCELLED", "Initialization was cancelled."));
        }
      };
      const cleanup = (): void => {
        input.off("keypress", onKeypress);
      };
      input.on("keypress", onKeypress);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    output.write("\n");
  }

  const selected = entries.filter((_entry, index) => state.selected[index] === true);
  if (selected.length === 0) {
    throw new LlmWikiError("EMPTY_SOURCE_SCOPE", "Select at least one source.");
  }
  return selected;
}

function renderSelection(
  entries: string[],
  state: SelectionState,
  output: NodeJS.WritableStream,
  replace: boolean,
): void {
  const lines = [
    "Knowledge sources (Up/Down move, Space toggles, Enter confirms, Esc cancels)",
    ...entries.map((entry, index) => {
      const cursor = index === state.cursor ? ">" : " ";
      const selected = state.selected[index] === true ? "x" : " ";
      return `${cursor} [${selected}] ${entry}`;
    }),
  ];
  if (replace) {
    output.write(`\x1b[${lines.length}F`);
  }
  output.write(`${lines.map((line) => `\x1b[2K${line}`).join("\n")}\n`);
}

function mapKey(
  character: string,
  key: { name?: string; ctrl?: boolean; sequence?: string },
): SelectionKey | null {
  if (key.ctrl === true && key.name === "c") {
    return "escape";
  }
  if (key.name === "up") {
    return "up";
  }
  if (key.name === "down") {
    return "down";
  }
  if (key.name === "return" || key.name === "enter") {
    return "enter";
  }
  if (key.name === "escape") {
    return "escape";
  }
  if (key.name === "space" || character === " " || key.sequence === " ") {
    return "space";
  }
  return null;
}

function isRawTty(stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream {
  return (
    "isTTY" in stream &&
    stream.isTTY === true &&
    "setRawMode" in stream &&
    typeof stream.setRawMode === "function"
  );
}
