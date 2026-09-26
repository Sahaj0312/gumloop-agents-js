/** API objects preserve additional server fields as the API evolves. */
export interface Agent extends Record<string, unknown> {
  id: string;
  name: string;
  description?: string | null;
  team_id?: string | null;
  model_name?: string | null;
  system_prompt?: string | null;
  is_active?: boolean;
  tools?: Record<string, unknown>[];
  resources?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
}
export interface AgentCreateRequest {
  name: string;
  model_name: string;
  description?: string | null;
  system_prompt?: string | null;
  tools?: Record<string, unknown>[];
  resources?: Record<string, unknown>[];
  skill_ids?: string[] | null;
  metadata?: Record<string, unknown> | null;
  folder_id?: string | null;
  /** false retires the agent; the public API cannot reactivate it. */
  is_active?: boolean;
  agent_id?: string | null;
  team_id?: string | null;
}
export type AgentUpdateRequest = {
  [K in keyof Omit<AgentCreateRequest, 'agent_id' | 'folder_id' | 'skill_ids'>]?: AgentCreateRequest[K] | null;
};
export interface AgentListRequest {
  search?: string;
  teamId?: string;
}
export interface AgentResponse { agent: Agent }
export interface AgentListResponse { agents: Agent[]; next_cursor?: string | null }
export interface Message extends Record<string, unknown> {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  parts?: Record<string, unknown>[] | null;
  created_at?: string | null;
  creator_id?: string | null;
}
export interface PendingApproval extends Record<string, unknown> {
  action_request_id?: string | null;
  type?: string;
  title?: string | null;
  reason?: string | null;
  recipient_user_id?: string | null;
  tool_name?: string | null;
  server_label?: string | null;
  display_fields?: string[][] | null;
  /** Question structure is not specified by the public schema. */
  questions?: Record<string, unknown>[] | null;
}
export interface Session extends Record<string, unknown> {
  id: string;
  agent_id: string;
  name?: string | null;
  state?: 'idle' | 'processing' | 'queued' | 'completed' | 'failed' | 'approval_required' | (string & {}) | null;
  messages?: Message[];
  pending_approvals?: PendingApproval[];
  created_at?: string | null;
  agent_name?: string | null;
  agent_team_id?: string | null;
  usage?: {
    credit_cost?: number | null;
    tool_credit_cost?: number | null;
    flow_credit_cost?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
  } | null;
}
export interface SessionResponse extends Record<string, unknown> { session: Session; queue_position?: number | null }
export interface SessionListResponse { sessions: Session[]; next_cursor?: string | null }
export interface SessionListRequest {
  search?: string;
  state?: string;
  type?: string;
  creator_user_id?: string;
  trigger_id?: string;
  sort_order?: 'newest' | 'oldest';
  page_size?: number;
  cursor?: string;
}
export interface SessionCreateRequest { input?: string; session_id?: string; metadata?: Record<string, unknown> }
export interface SessionMessageRequest { input: string }
export interface ApprovalResponse {
  action_request_id: string;
  action: 'accept' | 'reject';
  reason?: string;
  response?: { values: Record<string, unknown> };
}
export interface ResolveApprovalsRequest { approval_responses: ApprovalResponse[] }
export interface ResolveApprovalsResponse extends SessionResponse {
  results: { action_request_id: string; action: 'accept' | 'reject'; outcome: string }[];
  stream_cursor?: string | null;
}
export interface SSEMetadata {
  /** SSE event name; defaults to message. Not necessarily the payload's type. */
  event: string;
  /** Last SSE id, if the server sent one (including an empty reset). */
  id?: string;
  /** Server retry hint in ms; the client never reconnects automatically. */
  retry?: number;
  /** Original joined data lines, including payload fields named sse. */
  data: string;
}
export interface StreamEvent extends Record<string, unknown> {
  type?: string;
  stream_cursor?: string | null;
  final?: boolean;
  finishReason?: string;
  error?: unknown;
  errorMessage?: string;
  data?: unknown;
  /** Transport metadata; original payload is always recoverable from sse.data. */
  sse: SSEMetadata;
}
export interface RequestOptions { signal?: AbortSignal }
export interface GumloopOptions {
  apiKey?: string;
  accessToken?: string;
  userId?: string;
  teamId?: string;
  baseUrl?: string;
  streamBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}
