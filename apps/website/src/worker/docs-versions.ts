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
  }
];
