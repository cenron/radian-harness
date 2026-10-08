import type { State } from "#pi/state.ts";
import type { StatusView } from "#pi/status/status-view.ts";

export interface ToolDependencies {
  state: State;
  status: StatusView;
}
