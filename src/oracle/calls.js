// Words and small rules about phone calls, kept apart from the screens so they can be checked on their own.
import { firstName } from '../lib.js';

/** Has the phone service finished with this call? */
export const isOver = (call) => call.status === 'ended' || call.status === 'failed';

/** A stored number ("+14165550142") the way people write it. Anything that is not a North American number is left as it is. */
export function showNumber(number) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(number || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(number || '');
}
/** A tap-to-call address for a number however it was typed. */
export const telHref = (number) => `tel:${String(number || '').replace(/[^\d+]/g, '')}`;

/** What was typed, when it reads as a phone number rather than a name: digits and the usual punctuation, seven digits or more. */
export function typedNumber(text) {
  const t = String(text || '').trim();
  return /^[\d\s().+-]+$/.test(t) && t.replace(/\D/g, '').length >= 7 ? t : null;
}

const whoOf = (call) => (call.candidate_name ? firstName(call.candidate_name) : call.to_display || 'them');
/**
 * The few words that head each stage of a call. The sentence underneath comes from the server. `direction` is only
 * known for a call this page did not place itself (one that came in, or was rung in from the recruiter's own phone).
 */
export function headline(call) {
  switch (call.status) {
    case 'ringing_you': return call.direction === 'inbound' ? 'A call is coming in' : 'Ringing your phone…';
    case 'waiting_for_you': return call.direction === 'switchboard' ? 'Calling from your phone' : 'Answer and press 1';
    case 'calling_them': return `Calling ${whoOf(call)}…`;
    case 'in_call': return 'On the call';
    default: return { completed: 'Call ended', busy: 'Busy', no_answer: 'No answer', you_did_not_answer: 'Nobody was called', cancelled: 'Call cancelled' }[call.outcome] || 'The call was not made';
  }
}
/** Said until the server's own sentence for the stage arrives (the first second or so after Call is pressed). */
export const WAITING_WORDS = { ringing_you: 'Pick up, then press 1.', waiting_for_you: 'Press 1 on your phone to be connected.', calling_them: 'Their phone is ringing.', in_call: 'You are connected.' };

/**
 * The call being followed, after the server's latest word on it. The clock on screen counts from the moment this
 * page saw the two connected, so a call first seen when it was already under way has no clock rather than a wrong one.
 */
export function followed(was, fresh, now = Date.now()) {
  return { ...was, ...fresh, lost: false, talkingSince: was.talkingSince ?? (fresh.status === 'in_call' && was.status !== 'in_call' ? now : null) };
}

/** How a call came to be in The Oracle and who made it: "Recorded by Alex", "Uploaded by Alex", "Phone call placed by Alex". */
export function madeBy(call) {
  const who = call.created_by_name || 'someone who has left';
  if (call.source === 'phone') return `Phone call ${call.direction === 'inbound' ? 'taken' : call.direction === 'outbound' ? 'placed' : 'made'} by ${who}`;
  return `${call.source === 'uploaded' ? 'Uploaded' : 'Recorded'} by ${who}`;
}
