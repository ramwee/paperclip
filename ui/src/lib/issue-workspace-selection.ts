import type { ExecutionWorkspaceMode, Issue } from "@paperclipai/shared";
import {
  defaultExecutionWorkspaceModeForProject,
  issueExecutionWorkspaceModeForExistingWorkspace,
} from "./project-workspace-defaults";

export type IssueWorkspaceSelection = ExecutionWorkspaceMode | "reuse_existing";

type WorkspaceSelectionIssue = Pick<
  Issue,
  "executionWorkspaceId" | "executionWorkspacePreference" | "executionWorkspaceSettings" | "currentExecutionWorkspace"
>;

type WorkspaceSelectionProject = Parameters<typeof defaultExecutionWorkspaceModeForProject>[0];

export interface WorkspaceSelectionUpdate extends Record<string, unknown> {
  executionWorkspacePreference: IssueWorkspaceSelection;
  executionWorkspaceId: string | null;
  executionWorkspaceSettings: {
    mode: ExecutionWorkspaceMode;
    environmentId: null;
  };
}

/** Returns the option that should be presented for the issue's persisted workspace state. */
export function currentWorkspaceSelection(
  issue: WorkspaceSelectionIssue,
  project: WorkspaceSelectionProject,
): IssueWorkspaceSelection {
  const persistedMode =
    issue.currentExecutionWorkspace?.mode
    ?? issue.executionWorkspaceSettings?.mode
    ?? issue.executionWorkspacePreference;

  if (
    issue.executionWorkspaceId
    && (persistedMode === "isolated_workspace" || persistedMode === "operator_branch")
  ) {
    return "reuse_existing";
  }

  return (
    issue.executionWorkspacePreference
    ?? issue.executionWorkspaceSettings?.mode
    ?? defaultExecutionWorkspaceModeForProject(project)
  ) as IssueWorkspaceSelection;
}

/** Builds the legacy workspace-card update. A reuse selection needs a concrete workspace id. */
export function buildWorkspaceSelectionUpdate(
  selection: IssueWorkspaceSelection,
  workspaceId: string | null | undefined,
  reusedWorkspaceMode: string | null | undefined,
): WorkspaceSelectionUpdate | null {
  if (selection === "reuse_existing" && !workspaceId) return null;

  return {
    executionWorkspacePreference: selection,
    executionWorkspaceId: selection === "reuse_existing" ? workspaceId! : null,
    executionWorkspaceSettings: {
      mode: selection === "reuse_existing"
        ? issueExecutionWorkspaceModeForExistingWorkspace(reusedWorkspaceMode)
        : selection,
      environmentId: null,
    },
  };
}
