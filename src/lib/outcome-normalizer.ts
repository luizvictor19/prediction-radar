import { supabase } from './supabase.js';

export async function normalizeOutcome(
  eventId: string,
  rawInput: string,
): Promise<{ ok: true; outcome: string } | { ok: false; available: string[] }> {
  const { data: event } = await supabase
    .from('events')
    .select('outcomes')
    .eq('id', eventId)
    .single();

  const values = (event?.outcomes as any)?.values as string[] | undefined;
  if (!values || values.length === 0) {
    return { ok: false, available: [] };
  }

  const inputLower = rawInput.trim().toLowerCase();
  const match = values.find(v => v.toLowerCase() === inputLower);

  if (match) {
    return { ok: true, outcome: match };
  }

  return { ok: false, available: values };
}
