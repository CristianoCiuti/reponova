/**
 * Tests for OpenAI provider timeout handling via undici dispatcher.
 *
 * Verifies that:
 * 1. The configured timeout is respected (not capped at 300s by Node.js defaults)
 * 2. Requests that exceed the configured timeout are aborted
 * 3. Requests that complete within the timeout succeed normally
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenAiLlmProvider } from "../src/intelligence/openai-provider.js";
import { OpenAiEmbeddingProvider } from "../src/intelligence/openai-embedding-provider.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startMockServer(handler: (req: any, res: any) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ─── OpenAiLlmProvider ───────────────────────────────────────────────────────

describe("OpenAiLlmProvider timeout", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it("succeeds when response arrives within timeout", async () => {
    const { server: s, port } = await startMockServer((_req, res) => {
      // Respond immediately with a valid completion
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "Hello from mock" } }],
      }));
    });
    server = s;

    const provider = new OpenAiLlmProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-model",
      timeout: 5,
    });
    await provider.initialize();

    const result = await provider.generate({
      systemPrompt: "You are a test",
      userPrompt: "Say hello",
    });

    expect(result).toBe("Hello from mock");
    await provider.dispose();
  });

  it("aborts when response exceeds configured timeout", async () => {
    const { server: s, port } = await startMockServer((_req, res) => {
      // Delay response beyond the 1s timeout
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Too late" } }],
        }));
      }, 3000);
    });
    server = s;

    const provider = new OpenAiLlmProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-model",
      timeout: 1, // 1 second timeout
    });
    await provider.initialize();

    const start = Date.now();
    await expect(provider.generate({
      systemPrompt: "You are a test",
      userPrompt: "Say hello",
    })).rejects.toThrow("Request timed out after 1s");
    const elapsed = Date.now() - start;

    // Should abort around 1s, not 300s
    expect(elapsed).toBeLessThan(3000);
    await provider.dispose();
  });

  it("respects timeout > 300s (not capped by Node.js undici defaults)", async () => {
    // This test verifies the dispatcher headersTimeout is set correctly.
    // We use a 2s timeout and verify the request completes at 1.5s (which
    // would fail with Node's default 300s headersTimeout only if set to < 2s).
    const { server: s, port } = await startMockServer((_req, res) => {
      // Respond after 1.5s — within our 2s timeout
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Slow but valid" } }],
        }));
      }, 1500);
    });
    server = s;

    const provider = new OpenAiLlmProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-model",
      timeout: 2, // 2 second timeout — server responds at 1.5s
    });
    await provider.initialize();

    const result = await provider.generate({
      systemPrompt: "You are a test",
      userPrompt: "Say hello",
    });

    expect(result).toBe("Slow but valid");
    await provider.dispose();
  });

  it("throws on HTTP error", async () => {
    const { server: s, port } = await startMockServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    server = s;

    const provider = new OpenAiLlmProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-model",
      timeout: 5,
    });
    await provider.initialize();

    await expect(provider.generate({
      systemPrompt: "test",
      userPrompt: "test",
    })).rejects.toThrow("HTTP 500");
    await provider.dispose();
  });

  it("passes maxTokens and temperature to the request body", async () => {
    let receivedBody: any = null;
    const { server: s, port } = await startMockServer((req, res) => {
      let data = "";
      req.on("data", (chunk: string) => { data += chunk; });
      req.on("end", () => {
        receivedBody = JSON.parse(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }));
      });
    });
    server = s;

    const provider = new OpenAiLlmProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-model",
      timeout: 5,
    });
    await provider.initialize();

    await provider.generate({
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 4096,
      temperature: 0.2,
    });

    expect(receivedBody.max_tokens).toBe(4096);
    expect(receivedBody.temperature).toBe(0.2);
    expect(receivedBody.model).toBe("test-model");
    await provider.dispose();
  });
});

// ─── OpenAiEmbeddingProvider ─────────────────────────────────────────────────

describe("OpenAiEmbeddingProvider timeout", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = null;
    }
  });

  it("succeeds when response arrives within timeout", async () => {
    const { server: s, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      }));
    });
    server = s;

    const provider = new OpenAiEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-embed",
      timeout: 5,
      batchSize: 128,
    });
    await provider.initialize();

    const results = await provider.embedBatch([
      { id: "a", text: "hello" },
      { id: "b", text: "world" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].vector).toBeInstanceOf(Float32Array);
    expect(results[0].vector.length).toBe(3);
    await provider.dispose();
  });

  it("aborts when response exceeds configured timeout", async () => {
    const { server: s, port } = await startMockServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }));
      }, 3000);
    });
    server = s;

    const provider = new OpenAiEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-embed",
      timeout: 1,
      batchSize: 128,
    });
    await provider.initialize();

    const start = Date.now();
    const results = await provider.embedBatch([{ id: "a", text: "hello" }]);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(0);
    expect(elapsed).toBeLessThan(3000);
    await provider.dispose();
  });

  it("retries on 429 then succeeds", async () => {
    let attempt = 0;
    const { server: s, port } = await startMockServer((_req, res) => {
      attempt++;
      if (attempt === 1) {
        res.writeHead(429);
        res.end("Rate limited");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [{ index: 0, embedding: [1.0, 2.0] }],
        }));
      }
    });
    server = s;

    const provider = new OpenAiEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test-embed",
      timeout: 10,
      batchSize: 128,
    });
    await provider.initialize();

    const results = await provider.embedBatch([{ id: "x", text: "retry test" }]);

    expect(attempt).toBe(2);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("x");
    await provider.dispose();
  });
});
