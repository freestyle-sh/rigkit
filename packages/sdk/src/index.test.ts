import { describe, expect, test } from "bun:test";
import {
  RIGKIT_SDK_VERSION,
  createRuntimeControlApiHandler,
  env,
  runtimeControlApi,
  runtimeControlOpenApiDocument,
  RuntimeHostRequestError,
  serveRuntime,
  serveRuntimeEffect,
  sequence,
  workflow,
} from "./index.ts";
import { defineHostCapabilities, defineHostCapability } from "./host.ts";

describe("@rigkit/sdk package boundary", () => {
  test("exports authoring API and project runtime entrypoints", () => {
    expect(RIGKIT_SDK_VERSION).toBe("0.3.0");
    expect(env).toBeTypeOf("function");
    expect(env.secret).toBeTypeOf("function");
    expect(sequence).toBeTypeOf("function");
    expect(workflow).toBeTypeOf("function");
    expect(serveRuntime).toBeTypeOf("function");
    expect(serveRuntimeEffect).toBeTypeOf("function");
    expect(createRuntimeControlApiHandler).toBeTypeOf("function");
    expect(runtimeControlApi).toBeDefined();
    const document = runtimeControlOpenApiDocument() as any;
    expect(document.paths["/runs"].post.operationId).toBe("startRun");
    expect(new RuntimeHostRequestError({ message: "host failed" }).code).toBe("HOST_REQUEST_FAILED");
  });

  test("exports typed host capability registration helpers", async () => {
    const single = defineHostCapability("demo.open", {
      schemaHash: "sha256:demo",
      handle: (params: { name: string }) => ({ opened: params.name }),
    });

    expect(single.id).toBe("demo.open");
    expect(single.schemaHash).toBe("sha256:demo");
    expect(single.handle({ name: "workspace" })).toEqual({ opened: "workspace" });

    const [registered] = defineHostCapabilities({
      "demo.close": {
        handle: async (params: { sessionId: string }) => ({ closed: params.sessionId }),
      },
    });

    expect(registered?.id).toBe("demo.close");
    await expect(registered?.handle({ sessionId: "session-1" })).resolves.toEqual({ closed: "session-1" });
  });
});
