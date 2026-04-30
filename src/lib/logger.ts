import { supabase } from './supabase.js';

interface LogEventParams {
  component: string;
  status: 'success' | 'error' | 'partial';
  message: string;
  metadata?: Record<string, unknown>;
}

export async function logEvent(params: LogEventParams): Promise<void> {
  const { error } = await supabase.from('system_logs').insert({
    component: params.component,
    status: params.status,
    message: params.message,
    metadata: params.metadata ?? null,
  });

  if (error) {
    console.error('[logger] Failed to write log entry:', error.message, params);
  }
}
