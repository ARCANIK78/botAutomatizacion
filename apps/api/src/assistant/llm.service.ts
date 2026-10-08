import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmResult {
  content: string;
  toolCalls: LlmToolCall[];
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  get enabled(): boolean {
    return env.llmEnabled();
  }

  async chat(messages: LlmMessage[], tools?: LlmTool[]): Promise<LlmResult> {
    const key = env.llmApiKey();
    if (!key) {
      throw new LlmError('LLM_API_KEY no está configurada', 0);
    }

    const body: Record<string, unknown> = {
      model: env.llmModel(),
      messages,
      temperature: env.llmTemperature(),
      max_tokens: env.llmMaxTokens(),
      reasoning_effort: env.llmReasoningEffort(),
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let res: Response;
    try {
      res = await fetch(
        `${env.llmBaseUrl().replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(env.llmTimeoutMs()),
        },
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Fallo al llamar al LLM: ${message}`);
      throw new LlmError(message, 0);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(
        `LLM respondió HTTP ${res.status}: ${detail.slice(0, 300)}`,
      );
      throw new LlmError(`LLM HTTP ${res.status}`, res.status);
    }

    const json = (await res
      .json()
      .catch(() => null)) as ChatCompletionResponse | null;
    const message = json?.choices?.[0]?.message;

    const toolCalls: LlmToolCall[] = (message?.tool_calls ?? [])
      .map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}',
      }))
      .filter((call) => call.name.length > 0);

    return {
      content: (message?.content ?? '').trim(),
      toolCalls,
    };
  }
}
