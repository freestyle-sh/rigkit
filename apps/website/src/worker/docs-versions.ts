export type ConfiguredDocsVersion = {
  version: string;
  label?: string;
  basePath: string;
  startPath?: string;
  binding?: string;
  current?: boolean;
  archive?: boolean;
};

export const DOCS_VERSIONS: ConfiguredDocsVersion[] = [
  {
    "version": "v0.3.0",
    "label": "v0.3.0 · Latest",
    "basePath": "/docs",
    "startPath": "/docs",
    "binding": "DOCS_LATEST",
    "current": true
  },
  {
    "version": "v0.2",
    "label": "v0.2 · v0.2.17",
    "basePath": "/docs/v0.2",
    "startPath": "/docs/v0.2",
    "binding": "DOCS_V0_2",
    "archive": true
  }
];
