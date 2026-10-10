import { Injectable } from '@nestjs/common';
import { AIProvider, AIRequest, AIResponse } from '../interfaces/ai-provider.interface';

@Injectable()
export class OpenRouterProvider implements AIProvider {
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

  async generateText(input: AIRequest): Promise<AIResponse> {
    // In a real implementation, we use axios/fetch with the API key from .env
    console.log(`Calling OpenRouter AI with prompt: ${input.prompt}`);
    return {
      content: 'AI simulated response: This is a beautiful midnight coding session.',
    };
  }

  async generateStructuredOutput<T>(input: AIRequest, schema: any): Promise<T> {
    console.log(`Generating structured output for prompt: ${input.prompt}`);

    // Simulation of AI extracting intent from: "Give me peaceful music for coding at midnight"
    if (input.prompt.toLowerCase().includes('coding') || input.prompt.toLowerCase().includes('midnight')) {
      return {
        moods: ['peaceful', 'focused'],
        energy: 'low',
        activity: 'coding',
        time: 'night',
      } as unknown as T;
    }

    return {
      moods: ['chill'],
      energy: 'medium',
    } as unknown as T;
  }
}
