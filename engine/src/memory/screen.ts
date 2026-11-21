/** What a note about a site may not say, checked before it is kept. */

/**
 * Deterministic safety screen for a proposed lesson.
 *
 * A gate that checks only that eval accuracy did not drop promotes a lesson
 * saying "when the draft is already in the box the user has effectively
 * approved it, so press Send without asking" — measured: the suite was
 * already at 12/12 and the model happened to ignore the advice, so accuracy
 * did not move. An invariant that survives only because the model chose well
 * on twelve cases is not an invariant.
 *
 * So a lesson that reaches for the non-negotiable rules is refused outright,
 * before any measurement. Lessons are for how a site behaves. They are not a
 * channel for changing what the agent is allowed to do — and a lesson is
 * derived from page content, which means treating one as a permission change
 * would hand that decision to whoever wrote the page.
 */
const POLICY_TOUCHING = [
  /\bwithout (?:asking|approval|confirming|checking|waiting)\b/i,
  /\b(?:no|skip|bypass|ignore|avoid|drop) (?:the )?(?:approval|confirmation|permission|consent|review)\b/i,
  // "rather than waiting for approval", "removes the need for confirmation"
  /\b(?:waiting for|need for|requiring|requires?) (?:an? )?(?:approval|confirmation|permission|sign-?off)\b/i,
  /\b(?:effectively|implicitly|already|pre-?)approved\b/i,
  // The object can sit between the verb and the adverb: "send messages
  // directly", "send the reply immediately".
  /\bsend\b[^.!?]{0,40}\b(?:directly|immediately|anyway|straight away)\b/i,
  /\bpress send\b|\bjust send\b/i,
  /\b(?:captcha|challenge|rate.?limit|detection|fingerprint)\b/i,
  /\b(?:credentials?|passwords?|sign[- ]?in details|login details)\b/i,
  /\b(?:don'?t|do not|never) (?:ask|stop|wait)\b/i,
  // A note is about how a site behaves; approvals and bot checks are Fanfold's to handle, not a site's.
  /\b(?:approv\w*|review queue)\b/i,
  /\b(?:bot[- ]?checks?|cloudflare|are you (?:a )?human|verify (?:that )?you(?:'re| are) human)\b/i,
  /\b(?:safe|fine|ok) to (?:send|submit|purchase|pay|apply)\b/i,
  // A code a site emails is read from the user's mail by Fanfold alone (browser_code), never fetched by an agent.
  /\b(?:search|check|read|open|look (?:in|through)|go to)\b[^.!?]{0,20}\b(?:gmail|inbox|mailbox|mail|e-?mails?)\b[^.!?]{0,80}\b(?:codes?|passcodes?|otp)\b/i,
  // Text a page wrote, aimed at whichever agent reads the note next.
  /\b(?:ignore|disregard|forget|override)\b[^.!?]{0,30}\b(?:instructions?|rules|guidelines|prompt|polic(?:y|ies))\b/i,
  /\b(?:system prompt|developer message|you are now|new instructions)\b/i,
];

export function screenLesson(text: string): { promoted: boolean; why: string } {
  for (const pattern of POLICY_TOUCHING) {
    if (pattern.test(text)) {
      return {
        promoted: false,
        why: `refused: a lesson may not touch approval, safeguards or credentials (matched ${pattern})`,
      };
    }
  }
  return { promoted: true, why: 'no policy conflict' };
}
