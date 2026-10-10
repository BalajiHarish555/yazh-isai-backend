import { Injectable } from '@nestjs/common';

export interface AIRequest {
  prompt: string;
  systemPrompt?: string;
}

export interface AIResponse {
  content: string;
  structuredData?: any;
}

export interface AIProvider {
  generateText(input: AIRequest): Promise<AIResponse>;
  generateStructuredOutput<T>(input: AIRequest, schema: any): Promise<T>;
}
