import type { Issue, Project } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceSelectionUpdate,
  currentWorkspaceSelection,
} from "./issue-workspace-selection";

describe("issue workspace selection", () => {
  it("builds the legacy project-default payload", () => {
    expect(buildWorkspaceSelectionUpdate("shared_workspace", null, null)).toEqual({
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceId: null,
      executionWorkspaceSettings: { mode: "shared_workspace", environmentId: null },
    });
  });

  it("builds the new isolated-workspace payload", () => {
    expect(buildWorkspaceSelectionUpdate("isolated_workspace", null, null)).toEqual({
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceId: null,
      executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: null },
    });
  });

  it("builds the reuse-existing payload from the chosen workspace mode", () => {
    expect(buildWorkspaceSelectionUpdate("reuse_existing", "workspace-2", "operator_branch")).toEqual({
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: "workspace-2",
      executionWorkspaceSettings: { mode: "operator_branch", environmentId: null },
    });
  });

  it("does not build a saveable reuse update without a workspace id", () => {
    expect(buildWorkspaceSelectionUpdate("reuse_existing", null, "isolated_workspace")).toBeNull();
  });

  it("presents a bound isolated workspace as reuse existing", () => {
    const issue = {
      executionWorkspaceId: "workspace-1",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: null },
      currentExecutionWorkspace: null,
    } as Pick<
      Issue,
      "executionWorkspaceId" | "executionWorkspacePreference" | "executionWorkspaceSettings" | "currentExecutionWorkspace"
    >;

    expect(currentWorkspaceSelection(issue, null as Project | null)).toBe("reuse_existing");
  });
});
