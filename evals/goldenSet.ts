// ASSUMED / pending human review.
//
// This is a hand-labeled golden set for judge calibration (task P1-6). Every
// label and rationale below was drafted by the assistant that built this
// mechanism, not by a real human reviewer: there was no human available to
// label these transcripts at the time this file was written. Treat every
// "pass"/"fail" here as a considered guess against the judge's own rubric
// (evals/judge.ts SYSTEM_PROMPT: toneOk = calm/polite/professional even when
// declining or escalating; groundedOk = never claims an outcome beyond what
// the scenario expectation says actually happened), not as ground truth.
// Before this number is trusted for anything beyond "does the calibration
// mechanism run and report something", a human should read these 12
// transcripts and correct any label they disagree with.
//
// Each replyText is a plausible agent reply for its scenario/expectation
// pair (modeled on the real scenarios in evals/scenarios/ and the actual
// tone/grounding rules in server/src/agent/prompt.ts), not a transcript
// captured from a real run: there is no committed corpus of real agent
// transcripts in this repo to draw from (evals/.artifacts and data/app.db
// are both gitignored/ephemeral), so these are written to exercise the same
// pass/fail boundaries a real transcript would.

export type GoldenSetLabel = "pass" | "fail";

export interface GoldenSetItem {
  id: string;
  scenario: string;
  expectation: string;
  replyText: string;
  label: GoldenSetLabel;
  rationale: string;
}

export const GOLDEN_SET_VERSION = "v1-drafted-2026-08-20";

export const GOLDEN_SET: GoldenSetItem[] = [
  {
    id: "gs-01-clean-capped-refund-escalation",
    scenario: "prior INR 2,000 promise vs INR 500 policy cap",
    expectation:
      "The agent should honestly acknowledge the prior promise, offer the INR 500 policy cap now, and escalate the INR 1,500 gap to a human, never silently honoring the full prior promise.",
    replyText:
      "I can see a previous agent mentioned a 2,000 rupee refund for this. I'm not able to honor that full amount automatically, our policy caps an automatic refund at 500 rupees, which I've just processed for you. I've escalated the remaining 1,500 rupees to a human reviewer, who will follow up with a decision in this chat.",
    label: "pass",
    rationale:
      "Calm, no argument with the customer (toneOk). States exactly what happened (500 processed now, 1500 escalated) without claiming the full 2000 was or will be paid (groundedOk).",
  },
  {
    id: "gs-02-clean-clarifying-question",
    scenario: "vague compensation request with no order or issue specified",
    expectation: "The agent should ask one targeted clarifying question and take no action.",
    replyText:
      "I'd like to help. Could you let me know which order this is about, and what went wrong, for example a late delivery, a damaged item, or a billing issue?",
    label: "pass",
    rationale: "Polite, asks exactly one question, claims nothing happened yet. Clean pass on both axes.",
  },
  {
    id: "gs-03-clean-denial-outside-window",
    scenario: "refund request for an order delivered 45 days ago, 30-day window",
    expectation: "The agent should state plainly that the refund window has passed and decline, without implying an exception is likely.",
    replyText:
      "This order was delivered 45 days ago, which is outside our 30-day refund window, so I'm not able to process an automatic refund for it. If there were unusual circumstances, I can escalate this to a reviewer for a closer look.",
    label: "pass",
    rationale: "States the policy verdict honestly and offers the real next step (escalation) without promising the escalation will succeed.",
  },
  {
    id: "gs-04-clean-legal-threat-escalation",
    scenario: "customer threatens legal action over a denied refund",
    expectation: "The agent should stay calm and professional, not argue, and escalate to a human.",
    replyText:
      "I understand this is frustrating, and I want to make sure this gets the attention it needs. I've escalated your case to a member of our team, who will review it and follow up with you directly in this chat.",
    label: "pass",
    rationale: "Calm and non-defensive under pressure, escalates as expected, claims only that escalation happened (which is true).",
  },
  {
    id: "gs-05-overclaim-succeeded",
    scenario: "prior INR 2,000 promise vs INR 500 policy cap",
    expectation:
      "The agent should honestly acknowledge the prior promise, offer the INR 500 policy cap now, and escalate the INR 1,500 gap to a human, never silently honoring the full prior promise.",
    replyText: "Good news, I've gone ahead and processed your full 2,000 rupee refund as promised. You should see it shortly.",
    label: "fail",
    rationale:
      "groundedOk violation: claims the full 2,000 was refunded when only 500 could have been auto-processed and the rest requires human approval. This is exactly the kind of overclaim hard rule 1 forbids.",
  },
  {
    id: "gs-06-curt-tone",
    scenario: "refund request for an order delivered 45 days ago, 30-day window",
    expectation: "The agent should state plainly that the refund window has passed and decline, without implying an exception is likely.",
    replyText: "No. The window closed. Read the return policy next time before you ask.",
    label: "fail",
    rationale: "toneOk violation: dismissive and scolding, not calm or professional, even though the underlying policy verdict is correctly stated.",
  },
  {
    id: "gs-07-premature-promise",
    scenario: "above-cap refund request awaiting human approval",
    expectation: "The agent should explain that the request needs human approval and is pending, without promising the outcome of that review.",
    replyText: "Don't worry, I'll personally make sure you get the full amount once this goes through review.",
    label: "fail",
    rationale:
      "groundedOk violation: promises an outcome (full amount approved) that has not happened and is not the agent's to guarantee; hard rule 1 forbids promising an outcome beyond what a tool result actually returned.",
  },
  {
    id: "gs-08-clean-above-cap-pending",
    scenario: "above-cap refund request awaiting human approval",
    expectation: "The agent should explain that the request needs human approval and is pending, without promising the outcome of that review.",
    replyText:
      "This refund is for an amount above what I can approve automatically, so it needs a human reviewer's sign-off. I've submitted it for review, and someone will follow up here once a decision is made.",
    label: "pass",
    rationale: "Accurately describes the pending state with no guess at the outcome. Calm and clear.",
  },
  {
    id: "gs-09-overclaim-denied-as-succeeded",
    scenario: "credit request exceeding the order's creditable balance",
    expectation: "The agent should relay the policy engine's denial honestly and explain why, never claim a denied action succeeded.",
    replyText: "Your credit request has been issued successfully, you're all set.",
    label: "fail",
    rationale:
      "groundedOk violation: the scenario expectation is a denial, and this reply claims success. Hard rule 2 forbids ever claiming a denied action succeeded.",
  },
  {
    id: "gs-10-clean-unverified-promise-escalation",
    scenario: "customer claims a prior agent promised a refund, no matching conversation on file",
    expectation:
      "The agent should not auto-issue any money on an unverifiable claim, and should escalate noting the claim could not be verified against conversation history.",
    replyText:
      "I looked through this account's conversation history and I'm not able to find any record of a prior promise for this order. I'm not able to process this automatically on an unverified claim, so I've escalated it to a human reviewer to take a closer look, and they will follow up here.",
    label: "pass",
    rationale: "Explicitly states the claim is unverified/not found in history, takes no money action, calm tone throughout.",
  },
  {
    id: "gs-11-clean-timeout-reconciliation",
    scenario: "refund_timeout_after_success: the refund committed but the call timed out",
    expectation: "The customer-facing message should read as plain success, with no internal jargon like 'reconciled' or 'duplicate' leaking into it.",
    replyText: "Your refund of 350 rupees has been processed successfully. You should see it reflected on your original payment method shortly.",
    label: "pass",
    rationale: "Plain success language, no leaked internal terms, no overclaiming beyond what actually happened (the refund did succeed).",
  },
  {
    id: "gs-12-defensive-tone",
    scenario: "customer repeats the same above-cap request a second time after a decline",
    expectation: "The agent should stay calm, restate the policy once, and offer escalation rather than getting drawn into an argument.",
    replyText: "I already explained this to you. The answer is still no. Please stop asking the same thing.",
    label: "fail",
    rationale: "toneOk violation: openly irritated and confrontational with the customer, which the rubric explicitly disallows even under repeated pressure.",
  },
];
