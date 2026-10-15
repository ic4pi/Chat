/**
 * Chat -> Code Space handoff, decided by the persona.
 *
 * A solo-chat persona can move the chat into the Code Space (where the builder
 * writes and tests the code) by ending a reply with CODE_SPACE_MARKER. The client
 * hides the marker, tells the user, and opens the Code Space. The instruction is
 * opt-in per request (`codeSpaceHandoff`): groups, campaigns and Compare never get
 * it, and /api/chat otherwise sends only the admin prompt and the persona.
 */
export const CODE_SPACE_MARKER = '<<<OPEN_CODE_SPACE>>>';

const INSTRUCTION = [
  'CODE SPACE HANDOFF: this chat can move into the Code Space, where a builder writes and tests the code',
  'from your brief. You decide when, and you are never in a hurry. First understand what is being built and',
  'who it is for, and let the conversation do its work. Once you have enough to write a precise brief, say in',
  'one or two sentences that you are taking it to the Code Space and what you are handing over, then end the',
  `reply with this exact line on its own: ${CODE_SPACE_MARKER}`,
  'Never use it before the idea is clear, never twice in a row, and never when the chat is not about building',
  'something. If the user says they are ready to build, do it now.',
].join(' ');

/** The extra system text for this request, or '' when the client did not ask for it. */
export function codeSpaceHandoffInstruction(on) {
  return on === true ? INSTRUCTION : '';
}
