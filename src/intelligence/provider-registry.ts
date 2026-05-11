import type { EmbeddingProvider, LlmProvider } from "./llm-provider.js";
import { LlmEnginePool } from "./llm-engine-pool.js";
import { OpenAiLlmProvider } from "./openai-provider.js";
import { OpenAiEmbeddingProvider } from "./openai-embedding-provider.js";
import { OnnxEmbeddingAdapter } from "./embeddings.js";
import type { ModelsConfig, ProviderConfig } from "../shared/types.js";

export class ProviderRegistry {
  private llmPool: LlmEnginePool;
  private llmProviders = new Map<string, Promise<LlmProvider | null>>();
  private embeddingProviders = new Map<string, Promise<EmbeddingProvider | null>>();

  constructor(
    private providers: Record<string, ProviderConfig>,
    private modelsConfig: ModelsConfig,
  ) {
    this.llmPool = new LlmEnginePool(modelsConfig);
  }

  async acquireLlm(providerName?: string): Promise<LlmProvider | null> {
    if (!providerName) return null;

    const cached = this.llmProviders.get(providerName);
    if (cached) return cached;

    const created = this.createLlmProvider(providerName);
    this.llmProviders.set(providerName, created);
    return created;
  }

  async acquireEmbedding(providerName?: string): Promise<EmbeddingProvider | null> {
    if (!providerName) return null;

    const cached = this.embeddingProviders.get(providerName);
    if (cached) return cached;

    const created = this.createEmbeddingProvider(providerName);
    this.embeddingProviders.set(providerName, created);
    return created;
  }

  async disposeAll(): Promise<void> {
    const settledLlmProviders = await Promise.all(this.llmProviders.values());
    await Promise.all(settledLlmProviders.filter(isDisposableProvider).map((provider) => provider.dispose()));

    const settledEmbeddingProviders = await Promise.all(this.embeddingProviders.values());
    await Promise.all(settledEmbeddingProviders.filter(isDisposableProvider).map((provider) => provider.dispose()));

    await this.llmPool.disposeAll();
    this.llmProviders.clear();
    this.embeddingProviders.clear();
  }

  private async createLlmProvider(providerName: string): Promise<LlmProvider | null> {
    const provider = this.requireProvider(providerName);

    if (provider.type === "openai") {
      const instance = new OpenAiLlmProvider({
        baseUrl: provider.base_url!,
        model: provider.model!,
        apiKey: provider.api_key,
        timeout: provider.timeout ?? 30,
      });
      const ready = await instance.initialize();
      return ready ? instance : null;
    }

    if (provider.type === "llama-cpp") {
      return this.llmPool.acquire(provider.model!, provider.context_size ?? 512);
    }

    return null;
  }

  private async createEmbeddingProvider(providerName: string): Promise<EmbeddingProvider | null> {
    const provider = this.requireProvider(providerName);

    if (provider.type === "openai") {
      const instance = new OpenAiEmbeddingProvider({
        baseUrl: provider.base_url!,
        model: provider.model!,
        apiKey: provider.api_key,
        timeout: provider.timeout ?? 30,
        batchSize: 128,
      });
      const ready = await instance.initialize();
      return ready ? instance : null;
    }

    if (provider.type === "onnx") {
      const instance = new OnnxEmbeddingAdapter(
        provider.model!,
        this.modelsConfig.cache_dir,
        this.modelsConfig.download_on_first_use,
      );
      const ready = await instance.initialize();
      return ready ? instance : null;
    }

    return null;
  }

  private requireProvider(providerName: string): ProviderConfig {
    const provider = this.providers[providerName];
    if (!provider) {
      throw new Error(`Provider \"${providerName}\" is not defined`);
    }
    return provider;
  }
}

function isDisposableProvider<T extends { dispose(): Promise<void> }>(provider: T | null): provider is T {
  return provider !== null;
}
