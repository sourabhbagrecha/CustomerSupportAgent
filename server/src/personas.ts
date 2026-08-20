// The 10 seeded demo personas (PLAN Section 11, extended by docs/plans/013),
// labeled by the edge case each demonstrates. IDs match
// fixtures/customers.json exactly.
export const DEMO_PERSONAS = [
  { customerId: "cust_001", name: "Ananya Rao", label: "Failed delivery refund" },
  { customerId: "cust_002", name: "Vikram Shah", label: "Duplicate payment" },
  { customerId: "cust_003", name: "Priya Nair", label: "Cancellation within window" },
  { customerId: "cust_004", name: "Rahul Mehta", label: "Multiple recent orders (ambiguous)" },
  { customerId: "cust_005", name: "Sneha Iyer", label: "Above-cap request (requires approval)" },
  { customerId: "cust_006", name: "Arjun Kapoor", label: "Prior promise vs. policy cap" },
  { customerId: "cust_007", name: "Divya Menon", label: "Escalation: distress + legal threat" },
  { customerId: "cust_008", name: "Karan Bhatia", label: "200-conversation history + retrieval stress test" },
  { customerId: "cust_009", name: "Meera Joshi", label: "Already refunded in full (follow-up ask)" },
  { customerId: "cust_010", name: "Nikhil Verma", label: "Refund taking longer than expected" },
] as const;
