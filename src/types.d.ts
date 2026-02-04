export interface IterationResult {
  /** Whether the iteration completed without errors */
  success: boolean;
  /** Whether the task is finished */
  complete: boolean;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  content: string | unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  num_turns?: number;
  total_cost_usd?: number;
}
