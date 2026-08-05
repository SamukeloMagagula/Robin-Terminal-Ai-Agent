export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Provider {
  id: string;
  name: string;
  isAuthenticated(): Promise<boolean>;
  login(): Promise<void>;
  listModels(): Promise<string[]>;
  chat(model: string, messages: Message[]): AsyncIterable<string>;
  logout(): Promise<void>;
}
