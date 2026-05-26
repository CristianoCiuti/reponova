export type Target = "opencode" | "cursor" | "claude" | "vscode";

export interface InstallerContext {
  projectDir: string;
  graphDir: string;
}
