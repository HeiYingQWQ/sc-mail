export const AI_PROVIDER = Symbol('AI_PROVIDER');

export type AIOptions = {
  timeoutMs: number;
  retryCount: number;
  baseUrl?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(prompt: string, schema: unknown, options?: AIOptions): Promise<T>;
}

export class AIProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AIProviderError';
  }
}
