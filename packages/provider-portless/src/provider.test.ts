import { describe, expect, test } from "bun:test";
import { createPortlessController, createPortlessRoute } from "./provider.ts";

describe("Portless provider", () => {
  test("builds an HTTPS route with Portless defaults", async () => {
    const controller = createPortlessController({});
    const runtime = await controller.runtime({} as never);
    const route = runtime.route({
      name: "Website",
      appPort: 4321,
      command: "bun run dev",
    });

    expect(route).toMatchObject({
      name: "website",
      hostname: "website.localhost",
      url: "https://website.localhost",
      proxyPort: 443,
    });
    expect(route.command).toStartWith("env PORTLESS_PORT='443'");
    expect(route.command).toContain("PORTLESS_HTTPS='1'");
    expect(route.command).toContain("'portless' run --name 'website' --app-port '4321'");
  });

  test("builds a port-free HTTP route for a root-owned remote machine", () => {
    const route = createPortlessRoute(
      { https: false, proxyPort: 80, syncHosts: false },
      {
        name: "preview.freestyle",
        appPort: 4321,
        command: "bun run dev -- --host 0.0.0.0 --port 4321",
      },
    );

    expect(route.url).toBe("http://preview.freestyle.localhost");
    expect(route.command).toStartWith("env PORTLESS_PORT='80'");
    expect(route.command).toContain("PORTLESS_SYNC_HOSTS='0'");
    expect(route.command).toContain("sh -lc 'bun run dev -- --host 0.0.0.0 --port 4321'");
  });

  test("includes a non-default proxy port in the URL", () => {
    const route = createPortlessRoute(
      { https: false, proxyPort: 1355, tld: "test" },
      { name: "api", appPort: 3000, command: "npm start" },
    );

    expect(route.url).toBe("http://api.test:1355");
  });

  test("rejects unsafe names and invalid ports", () => {
    expect(() => createPortlessRoute({}, {
      name: "hello world",
      appPort: 3000,
      command: "npm start",
    })).toThrow("Invalid Portless route name");

    expect(() => createPortlessRoute({}, {
      name: "web",
      appPort: 0,
      command: "npm start",
    })).toThrow("Invalid Portless appPort");
  });
});
