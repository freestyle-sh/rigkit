export type SnapshotContext = {
  snapshotId: string;
};

export type WebsiteContext = SnapshotContext & {
  repoPath: string;
  repo: string;
  devCommand: string;
  devPort: number;
  devHostname: string;
  devUrl: string;
};

export type WebsiteWorkspaceContext = Omit<WebsiteContext, "snapshotId"> & {
  vmId: string;
  branch: string;
};
